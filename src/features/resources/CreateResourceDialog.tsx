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
import { fileSystemHash } from '../files/file-location';
import { databaseEditorHash } from '../navigation/workspace-route';
import { generateResourceName } from './resource-name';
import {
  resourceCreationContext,
  resourceKindLabels,
  type ResourceCreationTarget,
  type CreatableResourceKind,
} from './resource-creation';

export function CreateResourceDialog({
  data,
  refresh,
  notify,
  onClose,
  target,
  onCreated,
  applyCreatedResource,
  isGuest,
}: {
  data: Data;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
  onClose: () => void;
  target: ResourceCreationTarget;
  onCreated?: (resource: Resource) => void;
  applyCreatedResource?: (workspaceId: string, resource: Resource) => void;
  isGuest: boolean;
}) {
  const context = resourceCreationContext(target, data.capabilities);
  const initialKind = context.initialKind;
  const [kind, setKind] = useState<CreatableResourceKind>(initialKind),
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
  const isPostgres = kind === 'postgresql';
  const unavailable = kind !== 'filesystem' && data.capabilities[kind].available === false;
  const locationUnavailable = !data.capabilities[kind].regions.includes(selectedRegion);
  function changeKind(k: CreatableResourceKind) {
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
      if (
        created.data &&
        applyCreatedResource &&
        created.data.status !== 'deleted' &&
        created.data.status !== 'deleting'
      ) {
        applyCreatedResource(data.workspace.id, created.data);
      } else {
        await refresh();
      }
      notify(
        isPostgres
          ? 'PostgreSQL database requested'
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
  const kindName = (value: CreatableResourceKind) =>
    value === 'postgresql' ? 'PostgreSQL Compatible' : resourceKindLabels[value];
  const kindSelect = (
    <NativeSelect
      label={target === 'database' ? 'Database type' : 'Resource type'}
      value={kind}
      disabled={busy}
      onChange={(event) => {
        const next = context.kinds.find((value) => value === event.currentTarget.value);
        if (next) changeKind(next);
      }}
      data={context.kinds.map((value) => ({ value, label: kindName(value) }))}
    />
  );
  return (
    <Modal
      title={context.title}
      description={
        target === 'database'
          ? 'Create a PostgreSQL-compatible database for your workspace.'
          : 'Add a building block to your agent workspace.'
      }
      onClose={onClose}
      busy={busy}
      focusTitle={target === 'database'}
    >
      <form onSubmit={create}>
        {context.kinds.length > 1 && kindSelect}
        {unavailable && (
          <Alert color="yellow">PostgreSQL-compatible databases are unavailable right now.</Alert>
        )}
        {!unavailable && (
          <TextInput
            label="Resource name"
            disabled={busy}
            description={
              isPostgres
                ? 'Start with a letter. Use 3–40 lowercase letters, numbers, hyphens, and underscores. Leave blank for an automatic name.'
                : 'Start with a letter. Use 3–40 lowercase letters, numbers, and hyphens. Leave blank for an automatic name.'
            }
            pattern={isPostgres ? '[a-z][a-z0-9_\\-]{2,39}' : '[a-z][a-z0-9\\-]{2,39}'}
            minLength={3}
            maxLength={40}
            value={nameDraft.value}
            onChange={(e) => setNameDraft({ value: e.target.value, automatic: false })}
            placeholder={kind === 'filesystem' ? 'e.g. quiet-harbor' : 'e.g. tidb_pg-sales'}
          />
        )}
        {!unavailable && (
          <div className="plan-selection">
            <div>
              <Zap size={17} />
              <strong>
                {isPostgres ? 'PostgreSQL Compatible' : liveFiles ? 'Anonymous trial' : 'Free tier'}
              </strong>
              <Badge style={{ flexShrink: 0 }}>Preview</Badge>
            </div>
            <Text component="p">
              {isPostgres ? (
                'Run SQL and work with tables using PostgreSQL-compatible syntax. Trial limits apply.'
              ) : liveFiles ? (
                'Real file storage. Trial quotas are enforced by the service.'
              ) : (
                <>
                  {data.capabilities[kind].storageGiB} GiB storage
                  {' · 2,000 files'}
                </>
              )}
            </Text>
            <small>
              {isPostgres
                ? 'Use your Workspace Key for SQL and schema access. Provider credentials stay in the backend.'
                : liveFiles
                  ? 'Creates a real trial File System. Internal credentials are managed by the Workspace service.'
                  : 'Local simulation. No real cloud resource will be provisioned.'}
            </small>
          </div>
        )}
        {isGuest && kind !== 'filesystem' && !unavailable && (
          <Text size="sm">Temporary workspace access ends 48 hours after it was created.</Text>
        )}
        {locationUnavailable && (
          <Alert color="yellow">No data location is available for this resource right now.</Alert>
        )}
        {limited && (
          <Alert className="notice" color="peacock" icon={<CircleHelp size={17} />}>
            <span>
              A file system for this provider already exists at the default location.{' '}
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
            disabled={busy || limited || unavailable || locationUnavailable}
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
