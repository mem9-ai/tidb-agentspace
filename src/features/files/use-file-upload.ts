import { useRef, useState } from 'react';
import { workspaceApi, type Resource, type WorkspaceFile } from '../../api/client';
import type { UploadProgress } from '../../api/upload-transport';
import { uploadFailureMessage } from '../../api/transport';

export type FileUploadStatus = {
  resourceId: string;
  path: string;
  name: string;
  size: number;
  phase: 'preparing' | 'uploading' | 'saving' | 'refreshing' | 'success' | 'error';
  loaded?: number;
  total?: number;
  message?: string;
};

export function useFileUpload({
  resource,
  directory,
  files,
  onBusyChange,
  onSaved,
}: {
  resource?: Resource;
  directory: string;
  files: WorkspaceFile[];
  onBusyChange: (busy: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [status, setStatus] = useState<FileUploadStatus | null>(null);
  const inFlight = useRef(false);
  async function upload(file: File) {
    if (!resource || inFlight.current) return;
    inFlight.current = true;
    onBusyChange(true);
    const identity = {
      resourceId: resource.id,
      path: (directory === '/' ? '' : directory) + '/' + file.name,
      name: file.name,
      size: file.size,
    };
    setStatus({ ...identity, phase: 'preparing' });
    const progress = (update: UploadProgress) => setStatus({ ...identity, ...update });
    try {
      if (resource.provider === 'drive9-anonymous') {
        if (file.size > (resource.uploadLimitBytes || 0))
          throw new Error('This file exceeds the current upload limit. Choose a smaller file.');
        setStatus({ ...identity, phase: 'uploading', loaded: 0, total: file.size });
        await workspaceApi.uploadFile(
          { resourceId: resource.id, path: identity.path },
          file,
          progress,
        );
      } else {
        if (file.size > 256 * 1024)
          throw new Error('Choose a UTF-8 text file no larger than 256 KiB.');
        if (files.some((item) => item.path === identity.path))
          throw new Error(
            'A file with this name already exists. Choose another name or open it to edit.',
          );
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
          if (content.includes('\0')) throw new Error('Binary content');
        } catch {
          throw new Error('Local demo uploads accept UTF-8 text files only.');
        }
        setStatus({ ...identity, phase: 'uploading', loaded: 0 });
        await workspaceApi.saveFile(
          { resourceId: resource.id, path: identity.path, type: 'file', content },
          progress,
        );
      }
      // A failed list refresh must never turn an acknowledged write into "Upload failed".
      setStatus({ ...identity, phase: 'refreshing' });
      try {
        await onSaved();
        setStatus({ ...identity, phase: 'success' });
      } catch {
        setStatus({
          ...identity,
          phase: 'success',
          message:
            'The file was saved, but the file list could not refresh. Refresh files to see it; do not upload it again.',
        });
      }
    } catch (cause) {
      setStatus({
        ...identity,
        phase: 'error',
        message: uploadFailureMessage(cause),
      });
    } finally {
      inFlight.current = false;
      onBusyChange(false);
    }
  }
  return { status, upload, dismiss: () => setStatus(null) };
}
