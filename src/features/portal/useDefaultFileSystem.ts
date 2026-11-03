import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi, type Data } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';

type Setup = { workspaceId: string; status: 'preparing' | 'ready' | 'skipped' | 'error' };

/** The server atomically rejects an initial resource after any prior resource history. */
export function useDefaultFileSystem(
  data: Data | null,
  refresh: () => Promise<void>,
  enabled: boolean,
) {
  const [setup, setSetup] = useState<Setup>();
  const attempted = useRef(new Set<string>());
  const workspaceId = data?.workspace.id;
  const region = data?.capabilities.filesystem.regions[0];
  const empty = Boolean(enabled && data && data.resources.length === 0 && !data.resourceNextCursor);

  const prepare = useCallback(async () => {
    if (!workspaceId) return;
    if (!region) {
      await refresh().catch(() => undefined);
      return;
    }
    attempted.current.add(workspaceId);
    setSetup({ workspaceId, status: 'preparing' });
    try {
      const created = await workspaceApi.createResource(
        { name: 'my-files', kind: 'filesystem', region, onlyIfNew: true },
        'workspace-default-files-v1',
      );
      if (!created.data) throw new Error('The workspace setup did not return a File System.');
      await refresh();
      setSetup({
        workspaceId,
        status: ['deleted', 'deleting'].includes(created.data.status)
          ? 'skipped'
          : created.data.status === 'active' && !created.data.connectionError
            ? 'ready'
            : 'error',
      });
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.code === 'WORKSPACE_NOT_NEW') {
        await refresh().catch(() => undefined);
        setSetup({ workspaceId, status: 'skipped' });
      } else {
        // The same idempotency key is reused; provider setup owns uncertain-effect recovery.
        await refresh().catch(() => undefined);
        setSetup({ workspaceId, status: 'error' });
      }
    }
  }, [workspaceId, region, refresh]);

  useEffect(() => {
    if (workspaceId && empty && region && !attempted.current.has(workspaceId)) void prepare();
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
    retry: prepare,
  };
}
