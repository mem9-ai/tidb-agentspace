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

export function storagePolicy(bucket, prefix) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`],
      },
    ],
  };
}

export function roleTrust(issuer, account, namespace, serviceAccount) {
  const provider = new URL(issuer);
  if (
    provider.protocol !== 'https:' ||
    !/^oidc\.eks\.[a-z0-9-]+\.amazonaws\.com$/.test(provider.hostname) ||
    !/^\/id\/[A-Za-z0-9]+$/.test(provider.pathname) ||
    !/^\d{12}$/.test(account)
  )
    throw new AnalyticsCloudError('Invalid EKS workload identity.');
  const identity = provider.host + provider.pathname;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/${identity}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${identity}:aud`]: 'sts.amazonaws.com',
            [`${identity}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
          },
        },
      },
    ],
  };
}

// Private operator preparation only. No CA signing key, Meta credential or customer data
// enters an analytics runtime. Existing source configuration bytes stay unchanged.
export async function prepareAnalytics(target, options, identity, makeCertificates = certificates) {
  const { namespace, deployment } = options;
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
    const metaRole = target.plan.services.find(
      (s) =>
        s.kind === 'metadata' &&
        decode(target.secret.data[basename(s.configFile)]).authorityId === authority,
    );
    if (!metaRole || dirname(metaRole.configFile) !== mount)
      throw new AnalyticsCloudError('Missing authority storage configuration.');
    const meta = decode(target.secret.data[basename(metaRole.configFile)]);
    const { endpoint, region } = meta.s3;
    const bucket = `studio-analytics-${kind}-${identity.account}-${owner}`;
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '') ||
      !/^[a-z0-9-]+$/.test(region || '') ||
      ![`https://s3.${region}.amazonaws.com`, 'https://s3.amazonaws.com'].includes(endpoint)
    )
      throw new AnalyticsCloudError('Expected the existing AWS S3 storage location.');
    const name = `analytics-${kind}-${owner}`;
    const host = `${name}.${namespace}.svc`;
    const roleName = `studio-analytics-${kind}-${owner}`;
    const roleArn = `arn:aws:iam::${identity.account}:role/${roleName}`;
    const tls = await makeCertificates(host);
    const token = randomBytes(32).toString('hex');
    const installationId = `analytics-${kind}-${randomUUID()}`;
    const prefix = `analytics/${owner}/${kind}/${installationId}`;
    const privateMount = '/run/analytics';
    const config = {
      authorityId: authority,
      installationId,
      bind: '0.0.0.0:7446',
      s3: { endpoint, bucket, region, prefix },
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
          env: [
            { name: 'AWS_REGION', value: region },
            { name: 'AWS_ROLE_ARN', value: roleArn },
            { name: 'AWS_WEB_IDENTITY_TOKEN_FILE', value: '/var/run/analytics-identity/token' },
            { name: 'AWS_EC2_METADATA_DISABLED', value: 'true' },
          ],
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
            { name: 'identity', mountPath: '/var/run/analytics-identity', readOnly: true },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'projected', secret: { secretName: secret.metadata.name, defaultMode: 0o440 } },
        { name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } },
        {
          name: 'identity',
          projected: {
            sources: [
              {
                serviceAccountToken: {
                  audience: 'sts.amazonaws.com',
                  expirationSeconds: 3600,
                  path: 'token',
                },
              },
            ],
          },
        },
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
      roleName,
      roleArn,
      bucket,
      region,
      prefix,
      trust: roleTrust(identity.issuer, identity.account, namespace, name),
      policy: storagePolicy(bucket, prefix),
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
    format: 1,
    owner,
    sourceUid: uid,
    sourceSecret: target.secret.metadata.name,
    sourceHash: digest(target.secret.data),
    image: target.runtime.image,
    apiSecret,
    entries,
  };
}
