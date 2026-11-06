import { workspaceApi, workspaceId } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';

const storageKey = 'studio:report-files';
const sampleDigest = 'd79064c635829b0aeac2824b49e3e189a838dd52f1669567f2efa8913c8e1f06';
export const samplePath = '/US sales sample.csv';
export type ReportFiles = { sample: string; report: string; revision: 1 | 2; expiresAt: number };

export function reportPath(files: ReportFiles) {
  return `/US sales report - revision ${files.revision}.md`;
}

export async function prepareReportFiles(report: string, revision: 1 | 2) {
  const endpoint = location.pathname.replace(/\/report\/?$/, '/api/v1/agent-trial/us-sales-v1.csv');
  const response = await fetch(endpoint, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  if (!response.ok) throw new Error('The source data could not be loaded. Try again.');
  const bytes = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== sampleDigest) throw new Error('The source data could not be verified. Try again.');
  const files: ReportFiles = {
    sample: new TextDecoder().decode(bytes),
    report,
    revision,
    expiresAt: Date.now() + 10 * 60_000,
  };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(files));
  } catch {
    throw new Error('Allow site storage in your browser, then try opening the report files again.');
  }
}

export function readReportFiles(): ReportFiles | null {
  try {
    const text = sessionStorage.getItem(storageKey);
    if (!text || text.length > 64 * 1024) return null;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      !('sample' in value) ||
      typeof value.sample !== 'string' ||
      !('report' in value) ||
      typeof value.report !== 'string' ||
      !value.report ||
      !('revision' in value) ||
      (value.revision !== 1 && value.revision !== 2) ||
      !('expiresAt' in value) ||
      typeof value.expiresAt !== 'number' ||
      value.expiresAt <= Date.now()
    )
      return null;
    return {
      sample: value.sample,
      report: value.report,
      revision: value.revision,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearReportFiles() {
  sessionStorage.removeItem(storageKey);
}

/** Conditional creation makes re-entry and retries preserve existing files and edits. */
export async function saveReportFiles(
  files: ReportFiles,
  resourceId: string,
  targetWorkspace: string,
) {
  function checkWorkspace() {
    if (workspaceId !== targetWorkspace)
      throw new Error('The workspace changed. Open the report again to continue.');
  }
  for (const [path, content] of [
    [samplePath, files.sample],
    [reportPath(files), files.report],
  ]) {
    const file = { resourceId, path };
    let exists = false;
    checkWorkspace();
    try {
      await workspaceApi.fileMetadata(resourceId, path);
      exists = true;
    } catch (error) {
      if (!(error instanceof WorkspaceApiError && error.status === 404)) throw error;
    }
    if (!exists) {
      checkWorkspace();
      try {
        const body = { ...file, type: 'file' as const, content };
        if (path === samplePath) await workspaceApi.createSampleFile(body);
        else await workspaceApi.saveReport(body);
      } catch (error) {
        if (!(error instanceof WorkspaceApiError && error.status === 412)) throw error;
      }
    }
    checkWorkspace();
    const saved = await workspaceApi.previewFile(file);
    if (saved.content !== content)
      throw new Error(
        `“${path.slice(1)}” already contains different content. Choose another file system to keep both.`,
      );
  }
}
