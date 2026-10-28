import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function name(value, field) {
  if (typeof value !== 'string' || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))
    throw new Error(`${field} must be a DNS label starting with a letter (1–63 characters).`);
  return value;
}

export function devResources({ namespace, deployment, container, image, storageClass }) {
  name(namespace, 'Namespace');
  name(deployment, 'Deployment');
  name(container, 'Container');
  name(storageClass, 'Storage class');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image ?? ''))
    throw new Error('The image must be pinned by its sha256 digest.');
  const labels = {
    'app.kubernetes.io/name': 'tidb-workspace-api',
    'app.kubernetes.io/instance': deployment,
  };
  const metadata = (resourceName) => ({ name: resourceName, namespace, labels });
  const probe = {
    httpGet: {
      path: '/api/health',
      port: 'http',
      httpHeaders: [{ name: 'Host', value: '127.0.0.1' }],
    },
    timeoutSeconds: 3,
    periodSeconds: 5,
  };
  return [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(deployment),
      spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress'], ingress: [] },
    },
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: metadata(`${deployment}-data`),
      spec: {
        accessModes: ['ReadWriteOncePod'],
        storageClassName: storageClass,
        resources: { requests: { storage: '10Gi' } },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(deployment),
      spec: {
        type: 'ClusterIP',
        selector: labels,
        ports: [{ name: 'http', port: 4318, targetPort: 'http' }],
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(deployment),
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        revisionHistoryLimit: 2,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              fsGroupChangePolicy: 'OnRootMismatch',
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: container,
                image,
                ports: [{ name: 'http', containerPort: 4318 }],
                env: [
                  { name: 'WORKSPACE_API_HOST', value: '0.0.0.0' },
                  { name: 'WORKSPACE_API_PORT', value: '4318' },
                  { name: 'WORKSPACE_DATA_FILE', value: '/data/workspace.json' },
                  { name: 'HOME', value: '/tmp' },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { cpu: '100m', memory: '256Mi', 'ephemeral-storage': '64Mi' },
                  limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
                },
                startupProbe: { ...probe, failureThreshold: 30 },
                readinessProbe: { ...probe, failureThreshold: 3 },
                livenessProbe: { ...probe, failureThreshold: 3 },
                volumeMounts: [
                  { name: 'data', mountPath: '/data' },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              { name: 'data', persistentVolumeClaim: { claimName: `${deployment}-data` } },
              { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
            ],
          },
        },
      },
    },
  ];
}

// Creation is deliberately separate from the normal image-only CD path. Never
// adopt or overwrite existing objects, and never delete a PVC on failure.
export function bootstrapDev(config, mode, kubectl) {
  if (!['bootstrap-preview', 'bootstrap'].includes(mode))
    throw new Error('Invalid bootstrap mode.');
  const resources = devResources(config);
  kubectl(['get', 'namespace', config.namespace, '-o', 'name']);
  const storage = JSON.parse(kubectl(['get', 'storageclass', config.storageClass, '-o', 'json']));
  if (storage.provisioner !== 'ebs.csi.aws.com')
    throw new Error('Bootstrap requires the EBS CSI storage class for ReadWriteOncePod.');
  kubectl(['get', 'csidriver', 'ebs.csi.aws.com', '-o', 'name']);
  for (const resource of resources) {
    const found = kubectl([
      'get',
      resource.kind,
      resource.metadata.name,
      '-n',
      config.namespace,
      '--ignore-not-found',
      '-o',
      'name',
    ]);
    if (found.trim())
      throw new Error(`${resource.kind} already exists; bootstrap will not overwrite it.`);
  }
  const manifest = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources });
  kubectl(['create', '--dry-run=server', '-f', '-', '-o', 'name'], manifest);
  if (mode === 'bootstrap') kubectl(['create', '-f', '-', '-o', 'name'], manifest);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = {
    namespace: process.env.DEPLOY_NAMESPACE,
    deployment: process.env.K8S_DEPLOYMENT,
    container: process.env.K8S_CONTAINER,
    image: process.env.IMAGE_REF,
    storageClass: process.env.STORAGE_CLASS,
  };
  bootstrapDev(config, process.argv[2], (args, input) => {
    const output = execFileSync('kubectl', ['--request-timeout=30s', ...args], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (args[0] === 'create') process.stdout.write(output);
    return output;
  });
}
