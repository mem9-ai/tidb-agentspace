import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read only. Reports configuration shape/field names; never values, tokens or file contents.
export function inspectNativeTarget({ namespace, deployment, container }, kubectl) {
  for (const value of [namespace, deployment, container])
    if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value || ''))
      throw new Error('Invalid deployment target.');
  const read = (kind, name) =>
    JSON.parse(kubectl(['get', kind, name, '-n', namespace, '-o', 'json']));
  const target = read('deployment', deployment);
  const pod = target.spec?.template?.spec;
  const runtime = pod?.containers?.find((c) => c.name === container);
  if (!runtime) throw new Error('Target container missing.');
  const refs = new Map();
  const add = (kind, name) => {
    if (name) refs.set(kind + ':' + name, { kind, name });
  };
  for (const e of runtime.env || []) {
    add('secret', e.valueFrom?.secretKeyRef?.name);
    add('configmap', e.valueFrom?.configMapKeyRef?.name);
  }
  for (const e of runtime.envFrom || []) {
    add('secret', e.secretRef?.name);
    add('configmap', e.configMapRef?.name);
  }
  for (const v of pod.volumes || []) {
    add('secret', v.secret?.secretName);
    add('configmap', v.configMap?.name);
  }
  const objects = [];
  for (const ref of refs.values()) {
    try {
      const object = read(ref.kind, ref.name);
      const data = object.data || {};
      const fields = [];
      for (const [key, encoded] of Object.entries(data)) {
        fields.push(key);
        const text =
          ref.kind === 'secret' ? Buffer.from(encoded, 'base64').toString('utf8') : encoded;
        if (typeof text === 'string' && text.length <= 256 * 1024) {
          try {
            const json = JSON.parse(text);
            const visit = (v, p, depth) => {
              if (depth > 5 || !v || typeof v !== 'object') return;
              for (const [k, child] of Object.entries(v)) {
                fields.push(p + '.' + k);
                visit(child, p + '.' + k, depth + 1);
              }
            };
            visit(json, key, 0);
          } catch {
            /* Non-JSON values never enter the report. */
          }
        }
      }
      objects.push({ ...ref, readable: true, fields: fields.slice(0, 256) });
    } catch {
      objects.push({ ...ref, readable: false });
    }
  }
  return {
    nativeRuntime:
      target.spec?.template?.metadata?.annotations?.['workspace.tidb.ai/runtime'] === 'rust-v1',
    replicas: target.spec.replicas,
    strategy: target.spec.strategy?.type,
    environmentNames: (runtime.env || []).map((e) => e.name),
    configurationObjects: objects,
  };
}
// Discovery stays read-only and never treats a name hint as permission to reuse a bucket.
export function discoverProjectStorage(aws) {
  const classify = (error) =>
    /AccessDenied|Unauthorized|Forbidden/.test(String(error.stderr || ''))
      ? 'permission-denied'
      : 'unavailable';
  let listed;
  try {
    listed = JSON.parse(
      aws([
        's3api',
        'list-buckets',
        '--max-items',
        '100',
        '--page-size',
        '100',
        '--output',
        'json',
      ]),
    );
  } catch (error) {
    return { status: classify(error), buckets: [] };
  }
  const all = Array.isArray(listed.Buckets) ? listed.Buckets : [];
  const candidates = all.filter(
    (b) => typeof b.Name === 'string' && /drive9|mem9|slatedb|workspace|tidb[.-]ai/i.test(b.Name),
  );
  const buckets = candidates.slice(0, 8).map((bucket) => {
    let region = bucket.BucketRegion || null;
    let regionStatus = region ? 'available' : 'unavailable';
    if (!region)
      try {
        region =
          JSON.parse(aws(['s3api', 'head-bucket', '--bucket', bucket.Name, '--output', 'json']))
            .BucketRegion || null;
        regionStatus = region ? 'available' : 'unavailable';
      } catch (error) {
        regionStatus = classify(error);
      }
    let tags = {};
    let tagStatus;
    try {
      const data = JSON.parse(
        aws(['s3api', 'get-bucket-tagging', '--bucket', bucket.Name, '--output', 'json']),
      );
      tags = Object.fromEntries(
        (data.TagSet || [])
          .filter((t) =>
            ['application', 'app', 'project', 'service', 'environment', 'env'].includes(
              String(t.Key).toLowerCase(),
            ),
          )
          .map((t) => [t.Key, String(t.Value).slice(0, 128)]),
      );
      tagStatus = 'available';
    } catch (error) {
      tagStatus = classify(error);
    }
    return { name: bucket.Name, region, regionStatus, projectTags: tags, tagStatus };
  });
  return {
    status: 'listed',
    examinedBucketCount: all.length,
    truncated: !!listed.NextToken || candidates.length > 8,
    buckets,
    selection:
      'Name hints only; confirm the intended bucket and runtime credential/workload identity before initialization.',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = inspectNativeTarget(
      {
        namespace: process.env.DEPLOY_NAMESPACE,
        deployment: process.env.K8S_DEPLOYMENT,
        container: process.env.K8S_CONTAINER,
      },
      (args) =>
        execFileSync('kubectl', ['--request-timeout=30s', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 35000,
        }),
    );
    result.objectStorage = discoverProjectStorage((args) =>
      execFileSync(
        'aws',
        [...args, '--cli-connect-timeout', '3', '--cli-read-timeout', '5', '--no-cli-pager'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 12000,
          env: { ...process.env, AWS_MAX_ATTEMPTS: '1' },
        },
      ),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(
      'Read-only native configuration inspection failed; no cluster resources were changed.',
    );
    process.exitCode = 1;
  }
}
