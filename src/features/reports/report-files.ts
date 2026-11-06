import { workspaceApi, workspaceId } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';

const transferLimit = 64 * 1024;
const storageKey = 'studio:report-files';
const sampleDigest = 'd79064c635829b0aeac2824b49e3e189a838dd52f1669567f2efa8913c8e1f06';
export const samplePath = '/us-sales.csv';
export type ReportFiles = {
  sample: string;
  report: string;
  revision: 1 | 2;
  markets?: boolean;
  reportId?: string;
  path?: string;
  sourcePath?: string;
  expiresAt: number;
};

export function reportPath(files: ReportFiles) {
  return (
    files.path ??
    (files.reportId
      ? '/us-sales-report.md'
      : files.markets
        ? '/US sales insights.md'
        : `/US sales report - revision ${files.revision}.md`)
  );
}

export async function prepareReportFiles(report: string, revision: 1 | 2, reportId: string) {
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
    reportId,
    expiresAt: Date.now() + 10 * 60_000,
  };
  storeReportFiles(files);
}

function storeReportFiles(files: ReportFiles) {
  const text = JSON.stringify(files);
  if (text.length > transferLimit)
    throw new Error(
      'These files are too large to carry through sign-in. Download them before leaving this workspace.',
    );
  try {
    sessionStorage.setItem(storageKey, text);
  } catch {
    throw new Error('Allow site storage in your browser, then try saving the report again.');
  }
}

/** Read the selected report and its saved source only, before leaving the current owner session. */
export async function prepareSavedReportFiles(
  resourceId: string,
  path: string,
  sourceWorkspace: string,
) {
  const markets = path === '/US sales insights.md';
  const match = /^\/US sales report - revision ([12])\.md$/.exec(path);
  const canonical = path === '/us-sales-report.md';
  if (!canonical && !markets && !match)
    throw new Error('Open the sales report to save it to TiDB Cloud.');
  const revision = match?.[1] === '1' ? 1 : 2;
  function checkWorkspace() {
    if (workspaceId !== sourceWorkspace)
      throw new Error('The workspace changed. Reopen the report and try again.');
  }
  checkWorkspace();
  const sourcePath = canonical ? samplePath : '/US sales sample.csv';
  const paths = [sourcePath, path];
  const before = await Promise.all(paths.map((p) => workspaceApi.fileMetadata(resourceId, p)));
  checkWorkspace();
  const contents = await Promise.all(
    paths.map((p) => workspaceApi.previewFile({ resourceId, path: p })),
  );
  checkWorkspace();
  const after = await Promise.all(paths.map((p) => workspaceApi.fileMetadata(resourceId, p)));
  checkWorkspace();
  if (before.some((file, i) => !file.data.version || file.data.version !== after[i].data.version))
    throw new Error('The report or its data changed while preparing to save. Try again.');
  const text = contents.map((file, i) => {
    if (
      file.unavailableReason ||
      typeof file.content !== 'string' ||
      file.size !== before[i].data.size ||
      new TextEncoder().encode(file.content).length !== file.size
    )
      throw new Error(
        'The complete report and source data could not be read. Keep this workspace open and try again.',
      );
    return file.content;
  });
  if (!text[1]) throw new Error('The report is empty. Save your report before continuing.');
  storeReportFiles({
    sample: text[0],
    report: text[1],
    revision: canonical && /revision=1 -->/.test(text[1]) ? 1 : revision,
    markets,
    path,
    sourcePath,
    reportId: /<!-- tidb-agent-workspace report=([a-f0-9-]{36}) revision=/.exec(text[1])?.[1],
    expiresAt: Date.now() + 10 * 60_000,
  });
}

export function readReportFiles(): ReportFiles | null {
  try {
    const text = sessionStorage.getItem(storageKey);
    if (!text || text.length > transferLimit) return null;
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
      markets: 'markets' in value && value.markets === true,
      reportId:
        'reportId' in value &&
        typeof value.reportId === 'string' &&
        /^[a-f0-9-]{36}$/.test(value.reportId)
          ? value.reportId
          : undefined,
      path:
        'path' in value &&
        typeof value.path === 'string' &&
        /^\/(us-sales-report|US sales insights|US sales report - revision [12])\.md$/.test(
          value.path,
        )
          ? value.path
          : undefined,
      sourcePath:
        'sourcePath' in value && value.sourcePath === '/US sales sample.csv'
          ? value.sourcePath
          : samplePath,
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
    [files.sourcePath ?? samplePath, files.sample],
    [reportPath(files), files.report],
  ]) {
    const file = { resourceId, path };
    let exists = false;
    let version: string | null = null;
    checkWorkspace();
    try {
      version = (await workspaceApi.fileMetadata(resourceId, path)).data.version;
      exists = true;
    } catch (error) {
      if (!(error instanceof WorkspaceApiError && error.status === 404)) throw error;
    }
    if (!exists) {
      checkWorkspace();
      try {
        const body = { ...file, type: 'file' as const, content };
        if (path === (files.sourcePath ?? samplePath)) await workspaceApi.createSampleFile(body);
        else await workspaceApi.saveReport(body);
      } catch (error) {
        if (!(error instanceof WorkspaceApiError && error.status === 412)) throw error;
      }
    }
    checkWorkspace();
    let saved = await workspaceApi.previewFile(file);
    const key = `studio:report-import:${targetWorkspace}:${resourceId}:${path}`;
    const digest = async (value: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
    if (saved.content !== content && path === reportPath(files) && files.reportId && version) {
      let receipt: unknown;
      try {
        receipt = JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        /* Missing receipt must preserve the destination. */
      }
      if (
        receipt &&
        typeof receipt === 'object' &&
        'id' in receipt &&
        receipt.id === files.reportId &&
        'revision' in receipt &&
        typeof receipt.revision === 'number' &&
        receipt.revision <= files.revision &&
        'hash' in receipt &&
        receipt.hash === (await digest(saved.content || ''))
      ) {
        checkWorkspace();
        await workspaceApi.updateReport({ ...file, type: 'file', content }, version);
        checkWorkspace();
        saved = await workspaceApi.previewFile(file);
      }
    }
    if (saved.content !== content)
      throw new Error(
        `“${path.slice(1)}” already contains different content. Choose another file system to keep both.`,
      );
    if (path === reportPath(files) && files.reportId) {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            id: files.reportId,
            revision: files.revision,
            hash: await digest(content),
          }),
        );
      } catch {
        /* Reading and exact re-entry still work without receipts. */
      }
    }
  }
}
