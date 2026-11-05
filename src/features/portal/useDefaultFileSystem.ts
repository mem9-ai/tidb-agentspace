import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi, type Data, type Resource } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';

type Setup = { workspaceId: string; status: 'preparing' | 'ready' | 'skipped' | 'error' };

/** The server atomically rejects an initial resource after any prior resource history. */
export function useDefaultFileSystem(
  data: Data | null,
  refresh: () => Promise<void>,
  enabled: boolean,
  acceptResource: (workspaceId: string, resource: Resource) => void,
) {
  const [setup, setSetup] = useState<Setup>();
  const attempted = useRef(new Set<string>());
  const workspaceId = data?.workspace.id;
  const region = data?.capabilities.filesystem.regions[0];
  const empty = Boolean(enabled && data && data.resources.length === 0 && !data.resourceNextCursor);

  const prepare = useCallback(
    async (
      id: string,
      location: Data['capabilities']['filesystem']['regions'][number],
      workspaceLoaded: Promise<void> = Promise.resolve(),
    ) => {
      attempted.current.add(id);
      setSetup({ workspaceId: id, status: 'preparing' });
      try {
        // Both requests use the enrolled session. Apply the receipt after the initial
        // snapshot, even when provisioning finishes first.
        const [created] = await Promise.all([
          workspaceApi.createResource(
            { name: 'my-files', kind: 'filesystem', region: location, onlyIfNew: true },
            'workspace-default-files-v1',
          ),
          workspaceLoaded,
        ]);
        if (!created.data) throw new Error('The workspace setup did not return a File System.');
        const resource = created.data;
        if (resource.status === 'deleted' || resource.status === 'deleting') {
          await refresh();
          setSetup({ workspaceId: id, status: 'skipped' });
        } else {
          acceptResource(id, resource);
          setSetup({
            workspaceId: id,
            status: resource.status === 'active' && !resource.connectionError ? 'ready' : 'error',
          });
        }
      } catch (cause) {
        // An uncertain write or an existing workspace needs an authoritative observation.
        // Do not issue a second bootstrap when the initial load itself failed.
        await workspaceLoaded.then(refresh).catch(() => undefined);
        setSetup({
          workspaceId: id,
          status:
            cause instanceof WorkspaceApiError && cause.code === 'WORKSPACE_NOT_NEW'
              ? 'skipped'
              : 'error',
        });
      }
    },
    [refresh, acceptResource],
  );

  useEffect(() => {
    if (workspaceId && empty && region && !attempted.current.has(workspaceId))
      void prepare(workspaceId, region);
  }, [workspaceId, empty, region, prepare]);

  const current = setup && setup.workspaceId === workspaceId ? setup.status : undefined;
  const failedDefault = data?.resources.some(
    (resource) =>
      resource.isDefault &&
      resource.kind === 'filesystem' &&
      (resource.status !== 'active' || resource.connectionError),
  );
  const readyDefault = data?.resources.some(
    (resource) =>
      resource.isDefault &&
      resource.kind === 'filesystem' &&
      resource.status === 'active' &&
      !resource.connectionError,
  );
  return {
    preparing: current === 'preparing' || (empty && Boolean(region) && !current),
    error:
      !readyDefault &&
      (current === 'error' ||
        Boolean(failedDefault && current !== 'preparing') ||
        (empty && !region)),
    prepareNewGuest: prepare,
    retry: () =>
      workspaceId && region ? prepare(workspaceId, region) : refresh().catch(() => undefined),
  };
}
