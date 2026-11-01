const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const uid = /^[a-f0-9-]{36}$/;
const signals = [
  [
    /AccessDenied|UnauthorizedOperation|InvalidAccessKeyId|SignatureDoesNotMatch/i,
    'storage-authorization-denied',
  ],
  [/no storage class is set|no default storage class/i, 'storage-class-missing'],
  [/unbound.*PersistentVolumeClaim/i, 'volume-unbound'],
  [/Insufficient (cpu|memory)/i, 'compute-capacity-insufficient'],
  [/didn.t match.*(affinity|selector)/i, 'node-placement-unsatisfied'],
  [/Read-only file system/i, 'filesystem-read-only'],
  [/Permission denied/i, 'filesystem-permission-denied'],
  [/File exists/i, 'path-already-initialized'],
  [/No such file or directory/i, 'required-file-missing'],
  [/Invalid private|unknown field|missing field|invalid type/i, 'configuration-invalid'],
  [/Owner active|META_WRITER_ACTIVE|Installation mismatch/i, 'metadata-ownership-unavailable'],
  [/No credentials|credentials not found|Missing credentials/i, 'storage-credentials-unavailable'],
  [/Error:/i, 'process-error'],
];
export const startupIndicators = (text) =>
  signals.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
const condition = (value) =>
  (value || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason }));

// Fixed categories only. Never return event messages, raw logs, Pod spec/env or Secret data.
export function inspectCutover({ namespace, deployment }, kubectl) {
  if (![namespace, deployment].every((value) => dns.test(value || '')))
    throw new Error('Invalid diagnostic target.');
  const get = (kind, name, extra = []) =>
    JSON.parse(
      kubectl(['get', kind, ...(name ? [name] : []), '-n', namespace, ...extra, '-o', 'json']),
    );
  const safe = (read, fallback) => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const events = (object) => {
    if (!uid.test(object?.metadata?.uid || '')) return [];
    return safe(
      () =>
        get('events', undefined, ['--field-selector', `involvedObject.uid=${object.metadata.uid}`])
          .items.slice(0, 20)
          .map((event) => ({
            reason: event.reason,
            indicators: startupIndicators(String(event.message || '')),
          })),
      [],
    );
  };
  const prefix = deployment.slice(0, 32) + '-global-';
  const jobs = safe(
    () =>
      get('jobs').items.filter(
        (job) =>
          job.metadata?.name?.startsWith(prefix) &&
          /^[a-f0-9]{8}-[a-f0-9]{3}$/.test(job.metadata.name.slice(prefix.length)),
      ),
    null,
  );
  const result = {
    jobsReadable: jobs !== null,
    candidates: [],
    storageClasses: null,
    csiDrivers: null,
    boundStorageClasses: null,
  };
  result.boundStorageClasses = safe(
    () => [
      ...new Set(
        get('pvc')
          .items.filter((item) => item.status?.phase === 'Bound' && item.spec?.storageClassName)
          .map((item) => item.spec.storageClassName),
      ),
    ],
    null,
  );
  result.csiDrivers = safe(
    () =>
      JSON.parse(kubectl(['get', 'csidrivers', '-o', 'json'])).items.map(
        (item) => item.metadata.name,
      ),
    null,
  );
  result.storageClasses = safe(
    () =>
      JSON.parse(kubectl(['get', 'storageclasses', '-o', 'json'])).items.map((item) => ({
        name: item.metadata.name,
        provisioner: item.provisioner,
        bindingMode: item.volumeBindingMode,
        default:
          item.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ||
          item.metadata.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] ===
            'true',
      })),
    null,
  );
  for (const job of (jobs || []).slice(-8)) {
    const name = job.metadata.name;
    const volume = safe(() => get('pvc', name), undefined);
    const pods = safe(() => get('pods', undefined, ['-l', `job-name=${name}`]).items, []);
    result.candidates.push({
      name,
      conditions: condition(job.status?.conditions),
      active: job.status?.active || 0,
      succeeded: job.status?.succeeded || 0,
      failed: job.status?.failed || 0,
      volume: volume
        ? {
            phase: volume.status?.phase,
            storageClass: volume.spec?.storageClassName || null,
            conditions: condition(volume.status?.conditions),
            events: events(volume),
          }
        : null,
      pods: pods
        .filter((pod) => pod.metadata?.ownerReferences?.some((ref) => ref.uid === job.metadata.uid))
        .slice(0, 4)
        .map((pod) => {
          const statuses = [
            ...(pod.status?.initContainerStatuses || []),
            ...(pod.status?.containerStatuses || []),
          ];
          const containers = statuses.map((state) => {
            let indicators = [];
            if (dns.test(pod.metadata.name) && dns.test(state.name)) {
              indicators = safe(
                () =>
                  startupIndicators(
                    kubectl([
                      'logs',
                      `pod/${pod.metadata.name}`,
                      '-n',
                      namespace,
                      `--container=${state.name}`,
                      '--tail=100',
                    ]),
                  ),
                [],
              );
            }
            return {
              name: state.name,
              ready: state.ready,
              waiting: state.state?.waiting?.reason,
              terminated: state.state?.terminated?.reason,
              exitCode: state.state?.terminated?.exitCode,
              indicators,
            };
          });
          return {
            phase: pod.status?.phase,
            conditions: condition(pod.status?.conditions),
            events: events(pod),
            containers,
          };
        }),
    });
  }
  return result;
}
