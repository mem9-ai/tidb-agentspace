import type { workspaceApi } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport.ts';
import { fileExamplePath, fileExamples, type FileExampleKind } from './tutorial-data.ts';

type Api = Pick<typeof workspaceApi, 'previewFile' | 'uploadFile' | 'createSampleFile'>;

// Explicitly opening an example reuses any existing file, including customer edits.
// Every create is conditional, so concurrent attempts or uncertain responses cannot overwrite it.
export async function openFileExample(
  api: Api,
  resourceId: string,
  provider: string | undefined,
  sampleId: string,
  kind: FileExampleKind,
  beforeCreate?: () => Promise<void>,
) {
  const path = fileExamplePath(sampleId, kind);
  try {
    await api.previewFile({ resourceId, path });
    return path;
  } catch (error) {
    if (!(error instanceof WorkspaceApiError && error.status === 404)) throw error;
  }
  await beforeCreate?.();
  const content = fileExamples[kind].content;
  if (provider === 'drive9-anonymous') {
    await api.uploadFile(
      { resourceId, path },
      new Blob([content], { type: kind === 'csv' ? 'text/csv' : 'text/plain' }),
      () => {},
    );
  } else {
    await api.createSampleFile({ resourceId, path, type: 'file', content });
  }
  return path;
}
