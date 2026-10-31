import { useRef, useState, type FormEvent } from 'react';
import { Alert, Anchor, Badge, Button, NativeSelect, Text, TextInput } from '@tidbcloud/uikit';
import {
  IconHelpCircle as CircleHelp,
  IconPlus as Plus,
  IconZap as Zap,
} from '@tidbcloud/uikit/icons';
import { workspaceApi, type Data, type Resource } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';
import { WorkspaceModal as Modal } from '../../ui/WorkspaceModal';
import { regionLabel as region } from './regions';
import { fileSystemHash } from '../files/file-location';
import { databaseEditorHash } from '../navigation/workspace-route';
import { generateResourceName } from './resource-name';
import {
  resourceCreationContext,
  resourceKindLabels,
  type ResourceCreationTarget,
  type ResourceKind,
} from './resource-creation';

export function CreateResourceDialog({
  data,
  refresh,
  notify,
  onClose,
  target,
  onCreated,
}: {
  data: Data;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  onClose: () => void;
  target: ResourceCreationTarget;
  onCreated?: (resource: Resource) => void;
}) {
  const context = resourceCreationContext(target, data.capabilities);
  const initialKind = context.initialKind;
  const [kind, setKind] = useState<ResourceKind>(initialKind),
    [nameDraft, setNameDraft] = useState(() => ({
      value: generateResourceName(initialKind, data.resources),
      automatic: true,
    })),
    [selectedRegion, setRegion] = useState(context.initialRegion),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const createId = useRef(crypto.randomUUID());
  const liveFiles =
    kind === 'filesystem' && data.capabilities.filesystem.provider === 'drive9-anonymous';
  const liveMysql = kind === 'mysql' && data.capabilities.mysql.provider === 'tidb-cloud-zero';
  const livePg = kind === 'postgresql';
  const isDuckdb = kind === 'duckdb';
  const unavailable = (isDuckdb || livePg) && data.capabilities[kind].available === false;
  function changeKind(k: ResourceKind) {
    setKind(k);
    setNameDraft((current) =>
      current.automatic || !current.value
        ? { value: generateResourceName(k, data.resources), automatic: true }
        : current,
    );
    setRegion(data.capabilities[k].regions[0]);
    setError('');
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    const automatic = nameDraft.automatic || !nameDraft.value;
    const name =
      !nameDraft.value || (automatic && data.resources.some((r) => r.name === nameDraft.value))
        ? generateResourceName(kind, data.resources)
        : nameDraft.value;
    setNameDraft({ value: name, automatic });
    setBusy(true);
    setError('');
    try {
      const created = await workspaceApi.createResource(
        { name, kind, region: selectedRegion },
        createId.current,
      );
      await refresh();
      notify(
        isDuckdb
          ? 'DuckDB database requested'
          : livePg
            ? 'PostgreSQL database requested'
            : liveMysql
              ? 'Zero database requested'
              : liveFiles
                ? 'Trial File System requested'
                : 'Demo resource created',
      );
      onClose();
      const resource = created.data;
      if (resource && onCreated) {
        onCreated(resource);
        return;
      }
      location.hash = resource
        ? resource.kind === 'filesystem'
          ? fileSystemHash(resource.id)
          : databaseEditorHash(resource.id)
        : kind === 'filesystem'
          ? '#files'
          : '#databases';
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.code === 'NAME_EXISTS') {
        if (automatic) {
          setNameDraft({
            value: generateResourceName(kind, [...data.resources, { name }]),
            automatic: true,
          });
          setError('That name was taken. A new name is ready; choose Create again.');
        } else setError('This name is already in use. Choose another name.');
      } else setError(e instanceof Error ? e.message : 'Unable to create the resource.');
    } finally {
      setBusy(false);
    }
  }
  const existingFileSystem =
    kind === 'filesystem'
      ? data.resources.find(
          (r) =>
            r.kind === kind &&
            r.region === selectedRegion &&
            (r.provider || 'local') === (data.capabilities.filesystem.provider || 'local'),
        )
      : undefined;
  const limited = !!existingFileSystem;
  return (
    <Modal
      title={context.title}
      description="Add a building block to your agent workspace."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={create}>
        {context.kinds.length > 1 && (
          <NativeSelect
            label="Resource type"
            value={kind}
            disabled={busy}
            onChange={(event) => {
              const next = context.kinds.find((value) => value === event.currentTarget.value);
              if (next) changeKind(next);
            }}
            data={context.kinds.map((value) => ({
              value,
              label:
                value === 'mysql'
                  ? data.capabilities.mysql.provider === 'tidb-cloud-zero'
                    ? 'MySQL · TiDB Cloud Zero'
                    : 'MySQL demo'
                  : value === 'postgresql'
                    ? 'PostgreSQL · db9'
                    : resourceKindLabels[value],
            }))}
          />
        )}
        <TextInput
          label="Resource name"
          disabled={busy}
          description="3–40 lowercase letters, numbers, and hyphens. Leave blank for an automatic name."
          pattern="[a-z][a-z0-9-]{2,39}"
          minLength={3}
          maxLength={40}
          value={nameDraft.value}
          onChange={(e) => setNameDraft({ value: e.target.value, automatic: false })}
          placeholder={`${kind}-…`}
        />
        <NativeSelect
          label="Region"
          disabled={busy}
          description={
            <>
              {livePg
                ? 'db9 assigns the database region automatically.'
                : isDuckdb
                  ? 'Your DuckDB database runs in AWS Singapore.'
                  : liveMysql
                    ? 'TiDB Cloud Zero assigns the database region automatically.'
                    : kind === 'filesystem'
                      ? liveFiles
                        ? 'Anonymous trial hosted in AWS Singapore.'
                        : 'Defaults to AWS Singapore. The free-tier allowance applies per region.'
                      : 'Available regions depend on the resource provider.'}
            </>
          }
          value={selectedRegion}
          onChange={(e) => {
            const selected = data.capabilities[kind].regions.find(
              (value) => value === e.target.value,
            );
            if (selected) setRegion(selected);
          }}
        >
          {data.capabilities[kind].regions.map((r) => (
            <option key={r} value={r}>
              {region(r)}
            </option>
          ))}
        </NativeSelect>
        <div className="plan-selection">
          <div>
            <Zap size={17} />
            <strong>
              {livePg
                ? 'PostgreSQL database'
                : isDuckdb
                  ? 'DuckDB database'
                  : liveMysql
                    ? 'Temporary MySQL database'
                    : liveFiles
                      ? 'Anonymous trial'
                      : 'Free tier'}
            </strong>
            <Badge>
              {livePg
                ? 'Anonymous free tier'
                : isDuckdb
                  ? 'Experimental'
                  : liveMysql
                    ? 'Zero'
                    : kind === 'mysql'
                      ? 'Demo'
                      : 'Preview'}
            </Badge>
          </div>
          <Text component="p">
            {livePg ? (
              'A real PostgreSQL-compatible database from db9. No account or card required. Anonymous provider quotas apply; usage is not measured here.'
            ) : isDuckdb ? (
              'A persistent DuckDB database for SQL analytics. Workspace Keys control access; trial service limits apply.'
            ) : liveMysql ? (
              'No cloud account required. This real database expires within 30 days; export data before it expires.'
            ) : liveFiles ? (
              'Real file storage. Trial quotas are enforced by the service.'
            ) : (
              <>
                {data.capabilities[kind].storageGiB} GiB storage
                {kind === 'filesystem'
                  ? ' · 2,000 files'
                  : ` · ${data.capabilities[kind].monthlyRU! / 1000000}M RU / month`}
              </>
            )}
          </Text>
          <small>
            {livePg
              ? 'Internal credentials stay in the backend. Use your Workspace Key for SQL and schema access.'
              : isDuckdb
                ? 'Create tables, run SQL and browse your data from this database.'
                : liveMysql
                  ? 'Creates a real TiDB Cloud Zero database. Internal credentials stay in the backend. Use Workspace Keys for access.'
                  : liveFiles
                    ? 'Creates a real trial File System. Internal credentials are managed by the Workspace service.'
                    : 'Local simulation. No real cloud resource will be provisioned.'}
          </small>
        </div>
        {unavailable && (
          <Alert color="yellow">
            This database provider is not configured on this server. Contact your workspace
            operator.
          </Alert>
        )}
        {limited && (
          <Alert className="notice" color="peacock" icon={<CircleHelp size={17} />}>
            <span>
              A file system for this provider already exists in this region.{' '}
              {existingFileSystem && (
                <Anchor href={fileSystemHash(existingFileSystem.id)} onClick={onClose}>
                  Open {existingFileSystem.name}
                </Anchor>
              )}{' '}
              to continue.
            </span>
          </Alert>
        )}
        {error && (
          <Alert className="inline-error" color="red">
            {error}
          </Alert>
        )}
        <div className="modal-actions">
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="filled"
            disabled={busy || limited || unavailable}
            loading={busy}
            leftSection={<Plus size={18} />}
            type="submit"
          >
            {busy ? 'Creating…' : kind === 'filesystem' ? 'Create file system' : 'Create database'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
