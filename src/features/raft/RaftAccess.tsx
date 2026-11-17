import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  NativeSelect,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@tidbcloud/uikit';
import { Heading } from '../../ui/WorkspaceHeading';
import { errorMessage, RaftError } from './raft-api';
import type { RaftApi, RaftEnrollment, RaftGrant, RaftResource } from './raft-api';

export function RaftAccess({
  api,
  workspaceId,
  resources,
  onChanged,
}: {
  api: RaftApi;
  workspaceId: string;
  resources: RaftResource[];
  onChanged: () => Promise<void>;
}) {
  const [members, setMembers] = useState<RaftEnrollment[]>();
  const [next, setNext] = useState<string | null>();
  const [error, setError] = useState('');
  const [signInRequired, setSignInRequired] = useState(false);
  const [identityId, setIdentityId] = useState('');
  const [candidate, setCandidate] =
    useState<Awaited<ReturnType<RaftApi['admissionCandidate']>>['data']>();
  const invitationId = useRef('');
  const [history, setHistory] = useState<Awaited<ReturnType<RaftApi['audit']>>>();
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [target, setTarget] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [write, setWrite] = useState(false);
  const [tags, setTags] = useState(false);
  const [days, setDays] = useState('7');
  const [grants, setGrants] = useState<RaftGrant[]>();
  const [grantResource, setGrantResource] = useState('');
  const [grantCursor, setGrantCursor] = useState<string | null>();
  const [removing, setRemoving] = useState<RaftEnrollment>();
  const intent = useRef<{ body: string; id: string; expiresAt: number }>();
  const kind = resources.find((r) => r.id === targets[0])?.kind;
  const label = (member: RaftEnrollment) =>
    `${member.principal.identity.kind}: ${member.principal.identity.subject} · ${member.principal.id}`;
  const refresh = useCallback(async () => {
    const result = await api.enrollments(workspaceId);
    setGeneration((await api.workspace(workspaceId)).data.generation);
    setMembers(result.records.map((r) => r.value));
    setNext(result.nextCursor);
  }, [api, workspaceId]);
  useEffect(() => {
    setMembers(undefined);
    setGrants(undefined);
    setGrantResource('');
    void refresh().catch((e: unknown) => setError(errorMessage(e)));
  }, [refresh]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setSignInRequired(e instanceof RaftError && e.status === 401);
    } finally {
      setBusy(false);
    }
  }
  async function loadGrants(id: string, cursor?: string) {
    setGeneration((await api.workspace(workspaceId)).data.generation);
    const result = await api.grants(workspaceId, id, cursor);
    setGrants((items) => (cursor ? [...(items || []), ...result.data] : result.data));
    setGrantCursor(result.nextCursor);
    setGrantResource(id);
  }
  return (
    <Paper withBorder p="xl">
      <Stack>
        <Group justify="space-between">
          <Heading level={2}>People & agents</Heading>
          <Button variant="default" disabled={busy} onClick={() => void run(refresh)}>
            Refresh requests
          </Button>
        </Group>
        <Text>
          Share this Workspace ID with someone who should request admission:{' '}
          <Text component="span" fw={600}>
            {workspaceId}
          </Text>
        </Text>
        <Text size="sm" c="dimmed">
          Approval adds a member. Share specific resources separately; matching tags and Raft roles
          do not grant access.
        </Text>
        {error && (
          <Alert role="alert" color="red">
            {error}
            {signInRequired && (
              <Button component="a" href={api.loginUrl} mt="md">
                Sign in with Raft again
              </Button>
            )}
          </Alert>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const reviewed = await api.admissionCandidate(workspaceId, identityId);
              setGeneration((await api.workspace(workspaceId)).data.generation);
              invitationId.current = crypto.randomUUID();
              setCandidate(reviewed.data);
            });
          }}
        >
          <Group align="flex-end">
            <TextInput
              label="Identity ID from the agent’s context action"
              value={identityId}
              required
              onChange={(e) => setIdentityId(e.currentTarget.value)}
            />
            <Button type="submit" variant="default" disabled={busy || !identityId}>
              Review admission
            </Button>
          </Group>
        </form>
        <Modal
          opened={!!candidate}
          onClose={() => {
            if (!busy) setCandidate(undefined);
          }}
          title="Approve this identity?"
        >
          <Stack>
            {candidate && (
              <>
                <Text className="raft-identity">
                  {candidate.identity.kind} · {candidate.identity.subject}
                </Text>
                <Text className="raft-identity">Server: {candidate.identity.serverId}</Text>
                <Text className="raft-identity">Identity: {candidate.id}</Text>
              </>
            )}
            <Text>
              Membership grants no access to resources and no resource creation rights. Share exact
              resources separately after approval.
            </Text>
            {error && (
              <Alert color="red" role="alert">
                {error}
                {signInRequired && (
                  <Button component="a" href={api.loginUrl} mt="md">
                    Sign in with Raft again
                  </Button>
                )}
              </Alert>
            )}
            <Button
              disabled={busy || !candidate}
              onClick={() =>
                void run(async () => {
                  if (!candidate) return;
                  const result = await api.invite(
                    workspaceId,
                    invitationId.current,
                    candidate.id,
                    generation,
                  );
                  if (result.data.status !== 'approved')
                    throw new Error(
                      'This membership was removed. The original admission cannot restore it.',
                    );
                  setCandidate(undefined);
                  setIdentityId('');
                  await refresh();
                  await onChanged();
                })
              }
            >
              Approve membership
            </Button>
          </Stack>
        </Modal>
        {members === undefined ? (
          <Text>Loading requests…</Text>
        ) : members.length === 0 ? (
          <Text>No admission requests yet.</Text>
        ) : (
          members.map((member) => (
            <Group key={member.principal.id} justify="space-between" align="flex-start">
              <Text className="raft-identity">
                {label(member)} <Badge>{member.status}</Badge>
              </Text>

              <Group>
                {member.status === 'pending' ? (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.decide(workspaceId, member.principal.id, true, generation);
                          await refresh();
                        })
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      variant="default"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.decide(workspaceId, member.principal.id, false, generation);
                          await refresh();
                        })
                      }
                    >
                      Deny
                    </Button>
                  </>
                ) : (
                  member.status === 'approved' && (
                    <Button
                      variant="subtle"
                      color="red"
                      disabled={busy}
                      onClick={() => setRemoving(member)}
                    >
                      Remove membership
                    </Button>
                  )
                )}
              </Group>
            </Group>
          ))
        )}
        {next && (
          <Button
            variant="default"
            onClick={() =>
              void run(async () => {
                const page = await api.enrollments(workspaceId, next);
                setMembers([...(members || []), ...page.records.map((r) => r.value)]);
                setNext(page.nextCursor);
              })
            }
          >
            More requests
          </Button>
        )}
        <Group>
          <Button
            disabled={!resources.length || !members?.some((m) => m.status === 'approved')}
            onClick={() =>
              void run(async () => {
                setGeneration((await api.workspace(workspaceId)).data.generation);
                setSharing(true);
              })
            }
          >
            Share resources
          </Button>
          <NativeSelect
            label="Inspect resource access"
            value={grantResource}
            data={[
              { value: '', label: 'Choose a resource' },
              ...resources.map((r) => ({ value: r.id, label: r.name })),
            ]}
            onChange={(e) => {
              const id = e.currentTarget.value;
              if (id) void run(() => loadGrants(id));
            }}
          />
        </Group>
        {grants && (
          <Stack>
            {grants.length === 0 ? (
              <Text>No grants on this resource.</Text>
            ) : (
              grants.map((grant) => (
                <Group key={grant.id} justify="space-between" align="flex-start">
                  <div>
                    <Text className="raft-identity">
                      {members?.find((m) => m.principal.id === grant.principalId)?.principal
                        .identity.subject || grant.principalId}
                    </Text>
                    <Text size="sm">
                      {grant.actions.join(', ')} ·{' '}
                      {grant.revoked
                        ? 'Revoked'
                        : grant.expiresAt && grant.expiresAt * 1000 <= Date.now()
                          ? 'Expired'
                          : 'Configured'}
                      {grant.expiresAt
                        ? ` · Expires ${new Date(grant.expiresAt * 1000).toLocaleString()}`
                        : ' · Until revoked'}
                    </Text>
                  </div>
                  {!grant.revoked && (
                    <Button
                      variant="default"
                      color="red"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.share(
                            workspaceId,
                            grant.resourceId,
                            grant.id,
                            {
                              principalId: grant.principalId,
                              actions: grant.actions,
                              expiresAt: grant.expiresAt,
                              revoked: true,
                            },
                            generation,
                          );
                          await loadGrants(grantResource);
                          await onChanged();
                        })
                      }
                    >
                      Revoke grant
                    </Button>
                  )}
                </Group>
              ))
            )}
            {grantCursor && (
              <Button
                variant="default"
                onClick={() => void run(() => loadGrants(grantResource, grantCursor))}
              >
                More grants
              </Button>
            )}
          </Stack>
        )}
        <Button
          variant="subtle"
          disabled={busy}
          onClick={() => void run(async () => setHistory(await api.audit(workspaceId)))}
        >
          View access history
        </Button>
        {history && (
          <Stack>
            <Heading level={3}>Access history</Heading>
            {history.data.map((event) => (
              <Text key={event.id} className="raft-identity">
                {new Date(event.at).toLocaleString()} · {event.actor.kind} {event.actor.id} ·{' '}
                {event.action} · {event.outcome}
              </Text>
            ))}
            {history.nextCursor && (
              <Button
                variant="default"
                onClick={() =>
                  void run(async () => {
                    const page = await api.audit(workspaceId, history.nextCursor || undefined);
                    setHistory({ ...page, data: [...history.data, ...page.data] });
                  })
                }
              >
                More history
              </Button>
            )}
          </Stack>
        )}
        <Modal
          opened={sharing}
          onClose={() => {
            if (!busy) setSharing(false);
          }}
          title="Share exact resources"
          size="lg"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const actions: RaftGrant['actions'] = [
                  'resources:read',
                  kind === 'filesystem' ? 'files:read' : 'queries:read',
                ];
                if (write) actions.push(kind === 'filesystem' ? 'files:write' : 'queries:execute');
                if (tags) actions.push('tags:write');
                const body = { principalId: target, resourceIds: targets, actions };
                const serialized = JSON.stringify({ ...body, days });
                if (intent.current?.body !== serialized)
                  intent.current = {
                    body: serialized,
                    id: crypto.randomUUID(),
                    expiresAt: Math.floor(Date.now() / 1000) + Number(days) * 86400,
                  };
                const result = await api.shareBatch(
                  workspaceId,
                  {
                    ...body,
                    requestId: intent.current.id,
                    expiresAt: intent.current.expiresAt,
                  },
                  generation,
                );
                const incomplete = result.results.filter((r) => r.status !== 'applied');
                await onChanged();
                if (incomplete.length)
                  throw new Error(
                    `Some grants are incomplete: ${incomplete.map((r) => `${r.resourceId}: ${r.errorCode || r.status}`).join('; ')}. Retry this same selection.`,
                  );
                setSharing(false);
                setTargets([]);
                setWrite(false);
                setTags(false);
              });
            }}
          >
            <Stack>
              <NativeSelect
                label="Member"
                required
                data={[
                  { value: '', label: 'Choose an approved member' },
                  ...(members || [])
                    .filter((m) => m.status === 'approved')
                    .map((m) => ({ value: m.principal.id, label: label(m) })),
                ]}
                value={target}
                onChange={(e) => setTarget(e.currentTarget.value)}
              />
              <MultiSelect
                label="Resources to share"
                data={resources
                  .filter((r) => !kind || r.kind === kind)
                  .map((r) => ({ value: r.id, label: `${r.name} (${r.id})` }))}
                value={targets}
                onChange={setTargets}
                searchable
                maxValues={20}
                disabled={busy}
              />
              <NativeSelect
                label="Access expires after"
                value={days}
                data={[
                  { value: '1', label: '1 day' },
                  { value: '7', label: '7 days' },
                  { value: '30', label: '30 days' },
                  { value: '90', label: '90 days' },
                ]}
                onChange={(e) => setDays(e.currentTarget.value)}
              />
              <Text>
                Grants reading these exact resources. Later resources and tag matches are excluded.
              </Text>
              <Checkbox
                label="Allow writes"
                checked={write}
                onChange={(e) => setWrite(e.currentTarget.checked)}
              />
              <Checkbox
                label="Allow editing organizational tags"
                checked={tags}
                onChange={(e) => setTags(e.currentTarget.checked)}
              />
              <Text size="sm">
                Review the member and selected resources before sharing. Revoking one grant leaves
                any other active grants in effect.
              </Text>
              {error && (
                <Alert color="red" role="alert">
                  {error}
                </Alert>
              )}
              <Button type="submit" disabled={busy || !target || !targets.length} loading={busy}>
                Share selected resources
              </Button>
            </Stack>
          </form>
        </Modal>
        <Modal
          opened={!!removing}
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
          title="Remove membership?"
        >
          <Stack>
            {error && (
              <Alert color="red" role="alert">
                {error}
              </Alert>
            )}
            <Text>{removing && label(removing)}</Text>
            <Text>
              This stops access to this workspace without deleting its resources. This initial
              admission flow does not restore removed memberships.
            </Text>
            <Button
              color="red"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!removing) return;
                  await api.removeMember(workspaceId, removing.principal.id, generation);
                  setRemoving(undefined);
                  await refresh();
                  await onChanged();
                })
              }
            >
              Remove membership
            </Button>
          </Stack>
        </Modal>
      </Stack>
    </Paper>
  );
}
