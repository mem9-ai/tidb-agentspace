import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const encode = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const decode = (v) => JSON.parse(Buffer.from(v, 'base64').toString());
export const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const managedBy = 'studio-product-analytics';
export class AnalyticsCloudError extends Error {}

async function certificates(host) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-analytics-tls-'));
  const run = promisify(execFile);
  const path = (name) => join(directory, name);
  try {
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-keyout',
      path('ca.key'),
      '-out',
      path('ca.crt'),
      '-days',
      '365',
      '-subj',
      '/CN=studio-analytics-ca',
    ]);
    for (const kind of ['server', 'client']) {
      await run('openssl', [
        'req',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-keyout',
        path(`${kind}.key`),
        '-out',
        path(`${kind}.csr`),
        '-subj',
        `/CN=analytics-${kind}`,
      ]);
      await chmod(path(`${kind}.key`), 0o600);
      await writeFile(
        path(`${kind}.ext`),
        `extendedKeyUsage=${kind === 'server' ? 'serverAuth' : 'clientAuth'}\nsubjectAltName=DNS:${host}\n`,
        { mode: 0o600 },
      );
      await run('openssl', [
        'x509',
        '-req',
        '-in',
        path(`${kind}.csr`),
        '-CA',
        path('ca.crt'),
        '-CAkey',
        path('ca.key'),
        '-CAcreateserial',
        '-out',
        path(`${kind}.crt`),
        '-days',
        '365',
        '-extfile',
        path(`${kind}.ext`),
      ]);
    }
    return Object.fromEntries(
      await Promise.all(
        ['ca.crt', 'server.crt', 'server.key', 'client.crt', 'client.key'].map(async (name) => [
          name,
          (await readFile(path(name))).toString(),
        ]),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Private operator preparation only. No CA signing key, Meta credential or customer data
// enters an analytics runtime. Existing source configuration bytes stay unchanged.
export async function prepareAnalytics(
  target,
  options,
  storageClass,
  makeCertificates = certificates,
) {
  const { namespace, deployment } = options;
  if (typeof storageClass !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(storageClass))
    throw new AnalyticsCloudError('An existing cluster storage class is required.');
  const uid = target.source.metadata.uid;
  const mount = '/run/workspace';
  const globalRole = target.plan.services.filter((s) => s.kind === 'global');
  if (
    !uid ||
    target.plan.services.length !== 4 ||
    globalRole.length !== 1 ||
    !target.api.security ||
    !target.api.globalEntry ||
    target.api.analytics ||
    dirname(globalRole[0].configFile) !== mount
  )
    throw new AnalyticsCloudError(
      'Expected the existing secured Global/Region profile without analytics.',
    );
  const globalFile = basename(globalRole[0].configFile);
  const global = decode(target.secret.data[globalFile]);
  if (
    global.analytics ||
    global.regions?.length !== 1 ||
    global.regions[0].regionId !== target.api.authorityId ||
    target.api.publicOrigins?.[0] !== 'https://drive9.ai' ||
    target.api.publicPath !== '/studio'
  )
    throw new AnalyticsCloudError('Unsupported Global analytics topology.');
  const owner = digest({ namespace, deployment, uid }).slice(0, 12);
  const labels = {
    'app.kubernetes.io/managed-by': managedBy,
    'workspace.tidb.ai/analytics-owner': owner,
  };
  const data = { ...target.secret.data };
  const entries = [];
  for (const [kind, authority] of [
    ['global', 'global'],
    ['region', target.api.authorityId],
  ]) {
    const name = `analytics-${kind}-${owner}`;
    const host = `${name}.${namespace}.svc`;
    const tls = await makeCertificates(host);
    const token = randomBytes(32).toString('hex');
    const installationId = `analytics-${kind}-${randomUUID()}`;
    const prefix = `analytics/${owner}/${kind}/${installationId}`;
    const privateMount = '/run/analytics';
    const config = {
      authorityId: authority,
      installationId,
      bind: '0.0.0.0:7446',
      local: { directory: '/var/lib/analytics', prefix },
      tokenFile: `${privateMount}/token`,
      encryptionKeyFile: `${privateMount}/encryption-key`,
      pseudonymKeyFile: `${privateMount}/pseudonym-key`,
      campaigns: ['launch', 'operator-check'],
      tls: {
        certificateFile: `${privateMount}/server.crt`,
        privateKeyFile: `${privateMount}/server.key`,
        clientCaFile: `${privateMount}/ca.crt`,
      },
    };
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: `${name}-config`, namespace, labels },
      immutable: true,
      type: 'Opaque',
      data: {
        'config.json': encode(config),
        'deployment.json': encode({
          format: 1,
          services: [{ kind: 'analytics', configFile: `${privateMount}/config.json` }],
        }),
        token: encode(token),
        'encryption-key': encode(randomBytes(32).toString('hex')),
        'pseudonym-key': randomBytes(32).toString('base64'),
        'ca.crt': encode(tls['ca.crt']),
        'server.crt': encode(tls['server.crt']),
        'server.key': encode(tls['server.key']),
      },
    };
    const producerPrefix = `analytics-${kind}`;
    for (const file of ['ca.crt', 'client.crt', 'client.key'])
      data[`${producerPrefix}-${file}`] = encode(tls[file]);
    data[`${producerPrefix}-token`] = encode(token);
    const service = {
      endpoint: `https://${host}:7446`,
      tokenFile: `${mount}/${producerPrefix}-token`,
      tls: {
        caFile: `${mount}/${producerPrefix}-ca.crt`,
        certificateFile: `${mount}/${producerPrefix}-client.crt`,
        privateKeyFile: `${mount}/${producerPrefix}-client.key`,
      },
    };
    if (kind === 'global')
      global.analytics = {
        service,
        operatorsFile: `${mount}/admin-policy.json`,
        returnUrl: 'https://drive9.ai/studio/admin',
        browserEnabled: true,
        campaigns: ['launch', 'operator-check'],
      };
    else data['api.json'] = encode({ ...target.api, analytics: { enabled: true, service } });
    const account = {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name, namespace, labels },
      automountServiceAccountToken: false,
    };
    const pod = {
      serviceAccountName: name,
      automountServiceAccountToken: false,
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        runAsNonRoot: true,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      ...Object.fromEntries(
        ['nodeSelector', 'tolerations', 'imagePullSecrets']
          .filter((k) => target.pod[k])
          .map((k) => [k, structuredClone(target.pod[k])]),
      ),
      initContainers: [
        {
          name: 'private-config',
          image: target.runtime.image,
          command: [
            '/bin/sh',
            '-c',
            'umask 077; cp /projected/* /run/analytics/; chmod 600 /run/analytics/*',
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
            privileged: false,
            runAsUser: 1000,
            runAsGroup: 1000,
          },
          volumeMounts: [
            { name: 'projected', mountPath: '/projected', readOnly: true },
            { name: 'private', mountPath: privateMount },
          ],
        },
      ],
      containers: [
        {
          name: 'analytics',
          image: target.runtime.image,
          command: ['workspace-backend'],
          args: ['serve', '--config', `${privateMount}/deployment.json`],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
            privileged: false,
            runAsUser: 1000,
            runAsGroup: 1000,
          },
          resources: {
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '1', memory: '1Gi' },
          },
          ports: [{ name: 'analytics', containerPort: 7446 }],
          readinessProbe: { tcpSocket: { port: 7446 }, periodSeconds: 5 },
          livenessProbe: { tcpSocket: { port: 7446 }, initialDelaySeconds: 30, periodSeconds: 15 },
          volumeMounts: [
            { name: 'private', mountPath: privateMount, readOnly: true },
            { name: 'data', mountPath: '/var/lib/analytics' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'projected', secret: { secretName: secret.metadata.name, defaultMode: 0o440 } },
        { name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } },
        { name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
      ],
    };
    const jobPod = structuredClone(pod);
    jobPod.restartPolicy = 'Never';
    jobPod.containers[0].args[0] = 'initialize';
    for (const key of ['ports', 'readinessProbe', 'livenessProbe'])
      delete jobPod.containers[0][key];
    const workloadLabels = { ...labels, 'workspace.tidb.ai/analytics-authority': kind };
    entries.push({
      name,
      authority,
      volume: {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: `${name}-data`, namespace, labels },
        spec: {
          accessModes: ['ReadWriteOnce'],
          volumeMode: 'Filesystem',
          storageClassName: storageClass,
          resources: { requests: { storage: '5Gi' } },
        },
      },
      account,
      secret,
      service: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace, labels },
        spec: { selector: workloadLabels, ports: [{ port: 7446, targetPort: 7446 }] },
      },
      deployment: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, namespace, labels },
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: workloadLabels },
          template: { metadata: { labels: workloadLabels }, spec: pod },
        },
      },
      job: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: `${name}-initialize`, namespace, labels },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 180,
          template: { metadata: { labels: workloadLabels }, spec: jobPod },
        },
      },
    });
  }
  data[globalFile] = encode(global);
  data['admin-policy.json'] = encode({ subjects: [], verifiedEmailDomains: ['pingcap.com'] });
  const apiSecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `analytics-api-${owner}`,
      namespace,
      labels,
      annotations: { 'workspace.tidb.ai/analytics-source': target.secret.metadata.name },
    },
    immutable: true,
    type: 'Opaque',
    data,
  };
  return {
    format: 2,
    owner,
    sourceUid: uid,
    sourceSecret: target.secret.metadata.name,
    sourceHash: digest(target.secret.data),
    image: target.runtime.image,
    apiSecret,
    entries,
  };
}
