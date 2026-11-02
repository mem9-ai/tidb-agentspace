import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Loader,
  Paper,
  Table,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { useMediaQuery } from '@tidbcloud/uikit/hooks';
import { IconActivity, IconCopy03 } from '@tidbcloud/uikit/icons';
import {
  workspaceApi,
  type AuditHistory,
  type RequestHistory,
  type Resource,
} from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';
import { WorkspaceEmptyState } from '../../ui/WorkspaceEmptyState';
import './activity-history.css';

type RecordItem = AuditHistory['data'][number] | RequestHistory['data'][number];
type Page = Omit<AuditHistory, 'data'> & { data: RecordItem[] };
type Kind = 'audit' | 'requests';
type AuditRecord = AuditHistory['data'][number];

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unavailable' : date.toLocaleString();
}
function words(value: string) {
  const label = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim();
  return label ? label[0].toUpperCase() + label.slice(1) : 'Other';
}
function auditLabel(action: string) {
  const labels: Record<string, string> = {
    'workspace.update': 'Workspace settings',
    'resource.create': 'Resource creation',
    'resource.delete': 'Resource deletion',
    'resource.retry': 'Resource setup',
    'file.write': 'File saved',
    'file.delete': 'File deleted',
    'query.write': 'Database query',
    'query.execute': 'Database query',
    'database.import': 'Database import',
  };
  return labels[action] || words(action);
}
function matches(record: RecordItem, filter: string, targetName: string) {
  const fields =
    'operationId' in record
      ? [
          auditLabel(record.action),
          record.action,
          record.outcome,
          record.decision,
          record.actor.id,
          record.target?.id || '',
          targetName,
          record.requestId || '',
          record.operationId,
        ]
      : [
          record.operation,
          record.method,
          record.completion,
          String(record.status || ''),
          record.actor.id,
          record.requestId,
        ];
  return fields.some((value) => value.toLowerCase().includes(filter.toLowerCase()));
}
function AuditBadge({ record }: { record: AuditRecord }) {
  return (
    <Badge
      color={
        record.outcome === 'succeeded' ? 'green' : record.outcome === 'denied' ? 'red' : 'carbon'
      }
    >
      {words(record.outcome)}
      {record.outcome === 'attempted' && record.resolution ? ` · ${words(record.resolution)}` : ''}
    </Badge>
  );
}
function RequestReference({ id, copy }: { id?: string; copy: (value: string) => void }) {
  if (!id) return null;
  return (
    <div className="history-reference">
      <span title={id}>Request {id.slice(0, 8)}</span>
      <ActionIcon
        size="sm"
        variant="subtle"
        aria-label={`Copy request ID ${id}`}
        onClick={() => copy(id)}
      >
        <IconCopy03 size={14} />
      </ActionIcon>
    </div>
  );
}

export function ActivityHistory({
  workspaceId,
  workspaceName,
  resources,
  copy,
  kind,
  revision,
}: {
  workspaceId: string;
  workspaceName: string;
  resources: Resource[];
  copy: (value: string) => void;
  kind: Kind;
  revision: number;
}) {
  const narrow = useMediaQuery('(max-width: 767px)');
  const [page, setPage] = useState<Page | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cancelPending = useCallback(() => {
    current.current++;
    controller.current?.abort();
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      controller.current?.abort();
      const signal = new AbortController();
      controller.current = signal;
      const version = ++current.current;
      setLoading(true);
      setError('');
      try {
        const next =
          kind === 'audit'
            ? await workspaceApi.auditHistory(workspaceId, cursor, signal.signal)
            : await workspaceApi.requestHistory(workspaceId, cursor, signal.signal);
        if (version !== current.current) return;
        setPage((previous) => ({
          ...next,
          data: cursor && previous ? [...previous.data, ...next.data] : next.data,
        }));
      } catch (failure) {
        if (version !== current.current || signal.signal.aborted) return;
        setError(
          failure instanceof WorkspaceApiError && failure.status === 410
            ? 'This page has expired. Refresh to start again.'
            : 'Could not load history. Try again.',
        );
      } finally {
        if (version === current.current) setLoading(false);
      }
    },
    [kind, workspaceId],
  );

  useEffect(() => {
    setPage(null);
    setFilter('');
    void load();
    return cancelPending;
  }, [load, revision, cancelPending]);

  const names = new Map(resources.map((resource) => [resource.id, resource.name]));
  function targetLabel(target: NonNullable<AuditRecord['target']>) {
    const type = target.type === 'filesystem' ? 'File system' : words(target.type);
    const name =
      target.type === 'workspace' && target.id === workspaceId
        ? workspaceName
        : names.get(target.id) || target.id;
    return `${type} · ${name}`;
  }
  const entries =
    page?.data.filter((record) =>
      matches(
        record,
        filter,
        'operationId' in record && record.target ? targetLabel(record.target) : '',
      ),
    ) || [];
  const noun = kind === 'audit' ? 'audit records' : 'requests';
  const firstExclusion = page?.coverage.exclusions[0];
  const coverageSummary =
    firstExclusion === 'Global Key activity is not included'
      ? 'Workspace Key changes are not included'
      : firstExclusion === 'Global requests are not included'
        ? 'Workspace Key and access requests are not included'
        : firstExclusion;
  return (
    <section aria-label={kind === 'audit' ? 'Audit history' : 'HTTP request history'}>
      {page && (
        <>
          <Alert color="yellow" title="Some activity is not included" mb="md">
            Records cover this region. {coverageSummary && <>{coverageSummary}. </>}
            {page.coverage.startedAt
              ? `Recording started ${time(page.coverage.startedAt)}.`
              : 'Recording start unavailable.'}
            {page.coverage.exclusions.length > 1 && (
              <details>
                <summary>Coverage details</summary>
                <ul>
                  {page.coverage.exclusions.slice(1).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            )}
          </Alert>
          <Text size="sm" c="carbon.7" mb="md">
            Retained up to {page.retention.maxAgeDays} days and{' '}
            {page.retention.maxRecords.toLocaleString()} records.{' '}
            {page.retention.earliestAt && `Earliest retained: ${time(page.retention.earliestAt)}. `}
            {page.retention.truncated === true && 'Older records are no longer available. '}
            {page.health.status === 'degraded'
              ? 'Some records may be missing.'
              : page.health.status === 'unavailable'
                ? 'Recording status is unavailable.'
                : 'The full loss count is unavailable across restarts.'}
          </Text>
          <div className="log-toolbar">
            <div className="input-with-icon">
              <TextInput
                aria-label={`Filter loaded ${noun}`}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter loaded records…"
              />
            </div>
            <span>
              {entries.length}{' '}
              {kind === 'audit'
                ? entries.length === 1
                  ? 'audit record'
                  : 'audit records'
                : entries.length === 1
                  ? 'request'
                  : 'requests'}{' '}
              shown
            </span>
          </div>
          <Paper className="panel table-panel" withBorder>
            {narrow ? (
              <ul className="history-mobile-list">
                {entries.map((record) =>
                  'operationId' in record ? (
                    <li key={record.id}>
                      <div className="history-mobile-heading">
                        <strong>{auditLabel(record.action)}</strong>
                        <AuditBadge record={record} />
                      </div>
                      {record.target && (
                        <Text size="sm" title={record.target.id}>
                          {targetLabel(record.target)}
                        </Text>
                      )}
                      <Text size="sm" c="carbon.7">
                        {record.actor.kind === 'owner' ? 'Owner' : `Key · ${record.actor.id}`} ·{' '}
                        {time(record.occurredAt)}
                      </Text>
                      <RequestReference id={record.requestId} copy={copy} />
                    </li>
                  ) : (
                    <li key={record.id}>
                      <div className="history-mobile-heading">
                        <strong>
                          {record.method} · {words(record.operation)}
                        </strong>
                        <Badge color={record.status && record.status >= 400 ? 'red' : 'carbon'}>
                          {record.status ?? words(record.completion)}
                        </Badge>
                      </div>
                      <Text size="sm">
                        {record.actor.kind === 'owner' ? 'Owner' : `Key · ${record.actor.id}`} ·{' '}
                        {record.durationMs.toLocaleString()} ms
                      </Text>
                      <Text size="sm" c="carbon.7">
                        {time(record.startedAt)}
                      </Text>
                      <RequestReference id={record.requestId} copy={copy} />
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{kind === 'audit' ? 'Action' : 'Request'}</Table.Th>
                    <Table.Th>{kind === 'audit' ? 'Target' : 'Status'}</Table.Th>
                    <Table.Th>Actor</Table.Th>
                    <Table.Th>{kind === 'audit' ? 'Outcome' : 'Duration'}</Table.Th>
                    <Table.Th>Time</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {entries.map((record) =>
                    'operationId' in record ? (
                      <Table.Tr key={record.id}>
                        <Table.Td>
                          <span>{auditLabel(record.action)}</span>
                          <RequestReference id={record.requestId} copy={copy} />
                        </Table.Td>
                        <Table.Td title={record.target?.id}>
                          {record.target ? targetLabel(record.target) : '—'}
                        </Table.Td>
                        <Table.Td>
                          {record.actor.kind === 'owner' ? 'Owner' : `Key · ${record.actor.id}`}
                        </Table.Td>
                        <Table.Td>
                          <AuditBadge record={record} />
                        </Table.Td>
                        <Table.Td>{time(record.occurredAt)}</Table.Td>
                      </Table.Tr>
                    ) : (
                      <Table.Tr key={record.id}>
                        <Table.Td>
                          <span>
                            {record.method} · {words(record.operation)}
                          </span>
                          <RequestReference id={record.requestId} copy={copy} />
                        </Table.Td>
                        <Table.Td>{record.status ?? words(record.completion)}</Table.Td>
                        <Table.Td>
                          {record.actor.kind === 'owner' ? 'Owner' : `Key · ${record.actor.id}`}
                        </Table.Td>
                        <Table.Td>{record.durationMs.toLocaleString()} ms</Table.Td>
                        <Table.Td>{time(record.startedAt)}</Table.Td>
                      </Table.Tr>
                    ),
                  )}
                </Table.Tbody>
              </Table>
            )}
            {!entries.length && (
              <WorkspaceEmptyState
                icon={IconActivity}
                title={filter ? 'No matching records' : 'No records yet'}
                description={
                  filter
                    ? 'Try a different filter.'
                    : `New ${noun} will appear here when available.`
                }
              />
            )}
          </Paper>
          {page.nextCursor && (
            <Button
              mt="md"
              variant="outline"
              loading={loading}
              onClick={() => void load(page.nextCursor || undefined)}
            >
              Load more
            </Button>
          )}
        </>
      )}
      {loading && !page && (
        <div role="status">
          <Loader size="sm" /> <Text>Loading history…</Text>
        </div>
      )}
      {error && (
        <Alert color="red" role="alert" mt="md">
          {error}{' '}
          <Button variant="subtle" onClick={() => void load()}>
            Refresh
          </Button>
        </Alert>
      )}
    </section>
  );
}
