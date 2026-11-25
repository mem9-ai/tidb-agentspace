import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  NativeSelect,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { Heading } from '../../ui/WorkspaceHeading';
import { ThemePicker } from '../theme/ThemePicker';
import { RaftAccess } from './RaftAccess';
import { RaftResourcePanel } from './RaftResourcePanel';
import { errorMessage, raftApi, RaftError } from './raft-api';
import type { RaftApi, RaftContext, RaftResource } from './raft-api';
import './raft-console.css';

type Catalog = Awaited<ReturnType<RaftApi['catalog']>>;
export function RaftConsole() {
  const [api, setApi] = useState<RaftApi>();
  const [config, setConfig] = useState<Awaited<ReturnType<RaftApi['config']>>>();
  const [context, setContext] = useState<RaftContext | null>();
  const [workspaceId, setWorkspaceId] = useState('');
  const [resources, setResources] = useState<RaftResource[]>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [nextResources, setNextResources] = useState<string | null>();
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('My workspace');
  const [region, setRegion] = useState('');
  const [resourceName, setResourceName] = useState('');
  const [kind, setKind] = useState<'filesystem' | 'postgresql'>('filesystem');
  const [resourceRegion, setResourceRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [joinWorkspace, setJoinWorkspace] = useState(false);
  const [newResource, setNewResource] = useState(false);
  const [error, setError] = useState('');
  const [joinId, setJoinId] = useState('');
  const [joinStatus, setJoinStatus] = useState('');
  const intent = useRef<{ fingerprint: string; id: string }>();
  const selected = resources?.find((r) => r.id === selectedId);
  const workspace = context?.workspaces.find((w) => w.id === workspaceId);
  const canManage = workspace?.canManage === true;

  function requestId(input: unknown) {
    const fingerprint = JSON.stringify(input);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, id: crypto.randomUUID() };
    return intent.current.id;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function refreshIdentity(current: RaftApi) {
    const result = await current.context();
    setContext(result);
    setWorkspaceId((id) =>
      result.workspaces.some((w) => w.id === id) ? id : result.workspaces[0]?.id || '',
    );
  }
  async function loadResources(
    current: RaftApi,
    id: string,
    manage: boolean,
    stillActive = () => true,
  ) {
    const inventory = await current.inventory(id);
    const metadata = manage ? await current.catalog(id) : undefined;
    if (!stillActive()) return;
    setCatalog(metadata);
    setResources(
      metadata
        ? metadata.data.map((r) => inventory.resources.find((v) => v.id === r.id) || r)
        : inventory.resources,
    );
    setNextResources(inventory.nextCursor);
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await raftApi();
        const settings = await current.config();
        if (!active) return;
        setApi(current);
        setConfig(settings);
        setRegion(settings.regions[0] || '');
        try {
          await refreshIdentity(current);
        } catch (e) {
          if (e instanceof RaftError && e.status === 401) setContext(null);
          else throw e;
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!api || !workspaceId) return;
    let active = true;
    setResources(undefined);
    setCatalog(undefined);
    setSelectedId('');
    void loadResources(api, workspaceId, canManage, () => active).catch((e: unknown) => {
      if (active) setError(errorMessage(e));
    });
    return () => {
      active = false;
    };
  }, [api, workspaceId, canManage]);
  const capabilities = catalog?.capabilities;
  const supportedRegions = capabilities?.[kind]?.regions || [];
  const creationRegion = supportedRegions.includes(resourceRegion)
    ? resourceRegion
    : supportedRegions[0] || '';
  return (
    <Container size="lg" py="xl" className="raft-console">
      <Stack gap="xl">
        <Group justify="space-between" align="flex-start">
          <div>
            <Heading level={1}>AgentSpace</Heading>
            <Text c="dimmed">Private resources for you and your agents.</Text>
          </div>
          <Group>
            <ThemePicker />
            {context && api && (
              <Button
                variant="default"
                disabled={busy || dirty}
                onClick={() =>
                  void run(async () => {
                    await api.logout();
                    setContext(null);
                    setResources(undefined);
                  })
                }
              >
                Sign out
              </Button>
            )}
          </Group>
        </Group>
        {error && (
          <Alert color="red" role="alert" title="Couldn’t complete the request">
            {error}
            <Group mt="md">
              <Button variant="default" onClick={() => window.location.reload()}>
                Reload
              </Button>
              {config && (
                <Button component="a" href={config.loginUrl}>
                  Sign in again
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {context === undefined && !error && <Loader aria-label="Loading your workspace" />}
        {context === null && config && (
          <Paper withBorder p="xl">
            <Stack>
              <Heading level={2}>Continue with Raft</Heading>
              <Text>
                Sign in to create a workspace or request access to one. Signing in does not create
                cloud resources.
              </Text>
              <Button component="a" href={config.loginUrl} size="lg">
                Sign in with Raft
              </Button>
            </Stack>
          </Paper>
        )}
        {context && api && (
          <>
            <Group justify="space-between">
              <Text className="raft-identity">
                Signed in as {context.actor.kind} · {context.actor.id}
              </Text>
              <Badge>{context.actor.serverId}</Badge>
            </Group>
            <Group align="flex-end">
              <NativeSelect
                label="Workspace"
                value={workspaceId}
                data={context.workspaces.map((w) => ({ value: w.id, label: w.name }))}
                onChange={(e) => setWorkspaceId(e.currentTarget.value)}
                disabled={busy || dirty || !context.workspaces.length}
              />
              <Button
                variant="default"
                disabled={busy || dirty}
                onClick={() => void run(() => refreshIdentity(api))}
              >
                Refresh access
              </Button>
              {context.actor.kind === 'human' && (
                <Button
                  variant="default"
                  disabled={busy || dirty}
                  onClick={() => setNewWorkspace(true)}
                >
                  New workspace
                </Button>
              )}
              <Button
                variant="default"
                disabled={busy || dirty}
                onClick={() => setJoinWorkspace(true)}
              >
                Join workspace
              </Button>
            </Group>
            {context.nextCursor && (
              <Button
                variant="default"
                onClick={() =>
                  void run(async () => {
                    const page = await api.context(context.nextCursor || undefined);
                    setContext({
                      ...page,
                      workspaces: [...context.workspaces, ...page.workspaces],
                    });
                  })
                }
              >
                More workspaces
              </Button>
            )}
            {!workspaceId && (
              <Paper withBorder p="xl">
                <Stack>
                  <Heading level={2}>Your workspace starts here</Heading>
                  <Text>
                    Membership gives you a place to collaborate. A human must separately share each
                    resource.
                  </Text>
                </Stack>
              </Paper>
            )}
            {context.actor.kind === 'human' && (
              <Modal
                opened={newWorkspace}
                onClose={() => {
                  if (!busy) setNewWorkspace(false);
                }}
                title="Create a workspace"
              >
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      const input = { name, region };
                      const result = await api.createWorkspace(requestId(input), name, region);
                      await refreshIdentity(api);
                      setWorkspaceId(result.data.id);
                      intent.current = undefined;
                      setNewWorkspace(false);
                    });
                  }}
                >
                  <Stack>
                    {error && (
                      <Alert color="red" role="alert">
                        {error}
                      </Alert>
                    )}
                    <Group align="flex-end">
                      <TextInput
                        className="raft-input"
                        required
                        label="Workspace name"
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                        maxLength={100}
                      />
                      <NativeSelect
                        label="Region"
                        data={config?.regions || []}
                        value={region}
                        onChange={(e) => setRegion(e.currentTarget.value)}
                      />
                      <Button type="submit" disabled={busy || !region} loading={busy}>
                        Create workspace
                      </Button>
                    </Group>
                    <Text size="sm" c="dimmed">
                      Creates an empty workspace. Resources are created only when you choose to
                      create them.
                    </Text>
                  </Stack>
                </form>
              </Modal>
            )}
            <Modal
              opened={joinWorkspace}
              onClose={() => {
                if (!busy) setJoinWorkspace(false);
              }}
              title="Join a workspace"
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await api.enroll(joinId);
                    setJoinStatus(result.data.status);
                  });
                }}
              >
                <Stack>
                  {error && (
                    <Alert color="red" role="alert">
                      {error}
                    </Alert>
                  )}
                  <Group align="flex-end">
                    <TextInput
                      className="raft-input"
                      required
                      label="Workspace ID from its owner"
                      value={joinId}
                      onChange={(e) => {
                        setJoinId(e.currentTarget.value);
                        setJoinStatus('');
                      }}
                    />
                    <Button type="submit" disabled={busy || !joinId}>
                      Request access
                    </Button>
                    <Button
                      variant="default"
                      disabled={busy || !joinId}
                      onClick={() =>
                        void run(async () => {
                          const result = await api.ownEnrollment(joinId);
                          setJoinStatus(result.data?.status || 'No request yet');
                          await refreshIdentity(api);
                        })
                      }
                    >
                      Check request
                    </Button>
                  </Group>
                  {joinStatus && (
                    <Text role="status">
                      Admission: {joinStatus}. Approved members still need explicit resource access.
                    </Text>
                  )}
                </Stack>
              </form>
            </Modal>
            {workspaceId && (
              <>
                <Paper withBorder p="xl">
                  <Stack>
                    <Heading level={2}>Resources</Heading>
                    {resources === undefined ? (
                      <Text>Loading resources…</Text>
                    ) : (
                      <>
                        {resources.length === 0 && (
                          <Text>
                            No resources are available to you yet.
                            {canManage
                              ? ' Create a File System to save your first file.'
                              : ' Ask a human owner to share a resource.'}
                          </Text>
                        )}
                        <Group>
                          {resources.map((resource) => (
                            <Button
                              variant={selectedId === resource.id ? 'filled' : 'default'}
                              key={resource.id}
                              disabled={dirty}
                              onClick={() => setSelectedId(resource.id)}
                            >
                              {resource.name}
                            </Button>
                          ))}
                        </Group>
                        {nextResources && (
                          <Button
                            variant="default"
                            onClick={() =>
                              void run(async () => {
                                const page = await api.inventory(workspaceId, nextResources);
                                setResources((items) => [
                                  ...(items || []).map(
                                    (item) => page.resources.find((r) => r.id === item.id) || item,
                                  ),
                                  ...page.resources.filter(
                                    (r) => !items?.some((old) => old.id === r.id),
                                  ),
                                ]);
                                setNextResources(page.nextCursor);
                              })
                            }
                          >
                            More resources
                          </Button>
                        )}
                      </>
                    )}
                    {catalog?.nextCursor && (
                      <Button
                        variant="default"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const page = await api.catalog(
                              workspaceId,
                              catalog.nextCursor || undefined,
                            );
                            setCatalog({ ...page, data: [...catalog.data, ...page.data] });
                            setResources((items) => [
                              ...(items || []),
                              ...page.data.filter((r) => !items?.some((item) => item.id === r.id)),
                            ]);
                          })
                        }
                      >
                        More managed resources
                      </Button>
                    )}
                    {canManage && !!resources?.length && (
                      <Button
                        variant="default"
                        disabled={busy || dirty}
                        onClick={() => setNewResource(!newResource)}
                      >
                        {newResource ? 'Cancel creation' : 'Create another resource'}
                      </Button>
                    )}
                    {canManage && capabilities && (newResource || resources?.length === 0) && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(async () => {
                            const body = { kind, name: resourceName, region: creationRegion };
                            const result = await api.createResource(workspaceId, {
                              ...body,
                              requestId: requestId({ workspaceId, ...body }),
                            });
                            await loadResources(api, workspaceId, true);
                            setSelectedId(result.data.id);
                            setResourceName('');
                            intent.current = undefined;
                            setNewResource(false);
                          });
                        }}
                      >
                        <Stack>
                          <Group align="flex-end">
                            <NativeSelect
                              label="Resource type"
                              value={kind}
                              onChange={(e) => {
                                if (
                                  e.currentTarget.value === 'filesystem' ||
                                  e.currentTarget.value === 'postgresql'
                                )
                                  setKind(e.currentTarget.value);
                              }}
                              data={[
                                { value: 'filesystem', label: 'File System' },
                                ...(capabilities.postgresql.available
                                  ? [{ value: 'postgresql', label: 'PostgreSQL' }]
                                  : []),
                              ]}
                            />
                            <TextInput
                              className="raft-input"
                              label="Resource name"
                              required
                              value={resourceName}
                              placeholder={kind === 'filesystem' ? 'project-files' : 'project_data'}
                              onChange={(e) => setResourceName(e.currentTarget.value)}
                            />
                            <NativeSelect
                              label="Resource region"
                              value={creationRegion}
                              data={supportedRegions}
                              onChange={(e) => setResourceRegion(e.currentTarget.value)}
                            />
                            <Button type="submit" disabled={busy || !creationRegion}>
                              Create resource
                            </Button>
                          </Group>
                          <Text size="sm" c="dimmed">
                            {capabilities[kind].provider === 'local'
                              ? 'Files use this service’s local storage.'
                              : 'Creates a resource with the configured cloud provider.'}{' '}
                            Only you receive the initial access grant.
                          </Text>
                        </Stack>
                      </form>
                    )}
                  </Stack>
                </Paper>
                {selected && (
                  <RaftResourcePanel
                    key={`${workspaceId}/${selected.id}`}
                    api={api}
                    workspaceId={workspaceId}
                    resource={selected}
                    onDirty={setDirty}
                    onChanged={() => loadResources(api, workspaceId, canManage)}
                  />
                )}
                {canManage && (
                  <RaftAccess
                    key={workspaceId}
                    api={api}
                    workspaceId={workspaceId}
                    resources={resources || []}
                    onChanged={() => loadResources(api, workspaceId, canManage)}
                  />
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
