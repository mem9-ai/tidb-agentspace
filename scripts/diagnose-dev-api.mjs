import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dns = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const signals = [
  ['Metadata startup unavailable', 'metadata-unavailable'],
  ['Regional dependency unavailable', 'regional-dependency-unavailable'],
  ['Guest service setup unavailable', 'identity-setup-unavailable'],
  ['Workspace startup unavailable', 'workspace-startup-unavailable'],
  ['No configured service could start', 'no-service-started'],
  ['Rust full regional API listening', 'api-listening'],
  ['META_WRITER_ACTIVE', 'workspace-writer-active'],
  ['META_WORKSPACE_MISSING', 'workspace-missing'],
  ['Installation mismatch', 'metadata-installation-mismatch'],
  ['Invalid private deployment configuration', 'deployment-config-invalid'],
  ['Invalid private Workspace configuration', 'workspace-config-invalid'],
  ['Invalid private service configuration', 'metadata-config-invalid'],
  ['Private configuration requires', 'private-config-permissions'],
  ['No such file or directory', 'required-file-missing'],
  ['Permission denied', 'permission-denied'],
  ['Metadata authority, identity, key, token or listener is shared', 'metadata-config-collision'],
  ['Metadata storage roots overlap', 'metadata-roots-overlap'],
  ['A co-located Guest service requires', 'global-authority-missing'],
  ['An in-process dependency must be explicitly hosted', 'regional-authority-missing'],
  ['Guest requires explicit co-located', 'guest-config-invalid'],
  ['Invalid authority/environment identity', 'metadata-identity-invalid'],
  ['Metadata startup failed', 'metadata-start-failed'],
  ['Owner active/uncertain', 'metadata-owner-uncertain'],
  ['error while loading shared libraries', 'native-library-missing'],
  ['Error:', 'process-error'],
];

// Read-only: print bounded statuses and fixed labels only, never pod names, raw logs or config.
export function diagnose({ namespace, deployment, container }, kubectl) {
  if (
    ![namespace, deployment, container].every(
      (value) => typeof value === 'string' && dns.test(value),
    )
  )
    throw new Error('Invalid deployment target.');
  const target = JSON.parse(
    kubectl(['get', `deployment/${deployment}`, '-n', namespace, '-o', 'json']),
  );
  const labels = target.spec?.selector?.matchLabels;
  if (
    !labels ||
    Object.keys(labels).length === 0 ||
    Object.entries(labels).some(
      ([k, v]) => !/^[a-zA-Z0-9._/-]+$/.test(k) || !/^[a-zA-Z0-9._-]+$/.test(v),
    )
  )
    throw new Error('Deployment selector is unavailable or invalid.');
  const selector = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const pods = JSON.parse(kubectl(['get', 'pods', '-n', namespace, '-l', selector, '-o', 'json']));
  const result = {
    desired: target.spec?.replicas ?? 0,
    available: target.status?.availableReplicas ?? 0,
    pods: [],
    permissions: {},
  };
  for (const [label, verb, resource] of [
    ['createSecrets', 'create', 'secrets'],
    ['patchSecrets', 'patch', 'secrets'],
    ['patchDeployments', 'patch', 'deployments'],
    ['listSecrets', 'list', 'secrets'],
  ]) {
    try {
      const value = kubectl(['auth', 'can-i', verb, resource, '-n', namespace]).trim();
      result.permissions[label] = value === 'yes' ? true : value === 'no' ? false : null;
    } catch (error) {
      result.permissions[label] = String(error.stdout || '').trim() === 'no' ? false : null;
    }
  }
  const classify = (error) => {
    const text = String(error.stderr || '');
    if (/forbidden|unauthorized/i.test(text)) return 'denied';
    if (/invalid|unprocessable/i.test(text)) return 'invalid';
    if (/conflict|modified/i.test(text)) return 'conflict';
    return 'unavailable';
  };
  const probe = (args, input) => {
    try {
      kubectl(args, JSON.stringify(input));
      return 'accepted';
    } catch (error) {
      return classify(error);
    }
  };
  // Kubernetes server dry-run performs admission/authorization without persisting objects.
  const dummy = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: `workspace-check-${randomBytes(6).toString('hex')}`, namespace },
    immutable: true,
    data: { probe: 'eA==' },
  };
  result.repairProbe = {
    createDryRun: probe(
      ['create', '-f', '-', '-n', namespace, '--dry-run=server', '-o', 'name'],
      dummy,
    ),
    patchDryRun: null,
    replacementCopies: null,
  };
  if (target.metadata?.resourceVersion) {
    result.repairProbe.patchDryRun = probe(
      [
        'patch',
        `deployment/${deployment}`,
        '-n',
        namespace,
        '--type=merge',
        '--patch-file=/dev/stdin',
        '--dry-run=server',
        '-o',
        'name',
      ],
      { metadata: { resourceVersion: target.metadata.resourceVersion } },
    );
  }
  if (result.permissions.listSecrets === true) {
    try {
      const names = kubectl([
        'get',
        'secrets',
        '-n',
        namespace,
        '-o=jsonpath={.items[*].metadata.name}',
      ])
        .trim()
        .split(/\s+/);
      const references = (target.spec?.template?.spec?.volumes || [])
        .map((volume) => volume.secret?.secretName)
        .filter(Boolean);
      result.repairProbe.replacementCopies = names.filter((name) =>
        references.some(
          (reference) =>
            name.startsWith(`${reference}-execute-`) &&
            /^[a-f0-9]{12}$/.test(name.slice(reference.length + 9)),
        ),
      ).length;
    } catch {
      /* Listing can be unavailable even when self-review says it is permitted. */
    }
  }
  for (const pod of (pods.items || []).slice(0, 8)) {
    const name = pod.metadata?.name;
    if (!dns.test(name || '')) continue;
    const state = (pod.status?.containerStatuses || []).find((item) => item.name === container);
    const entry = {
      phase: ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(pod.status?.phase)
        ? pod.status.phase
        : 'Unknown',
      ready: state?.ready === true,
      restarts: state?.restartCount ?? 0,
      exitCode: state?.lastState?.terminated?.exitCode ?? null,
      logReads: 0,
      logAccessDenied: false,
      indicators: [],
    };
    for (const previous of [false, true]) {
      try {
        const args = [
          'logs',
          `pod/${name}`,
          '-n',
          namespace,
          `--container=${container}`,
          '--tail=200',
        ];
        if (previous) args.push('--previous');
        const logs = kubectl(args);
        entry.logReads += 1;
        for (const [needle, label] of signals)
          if (logs.includes(needle) && !entry.indicators.includes(label))
            entry.indicators.push(label);
      } catch (error) {
        if (/forbidden/i.test(String(error.stderr || ''))) entry.logAccessDenied = true;
      }
    }
    result.pods.push(entry);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = diagnose(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
      },
      (args, input) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          input,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 35_000,
        }),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
