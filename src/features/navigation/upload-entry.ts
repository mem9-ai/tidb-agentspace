export const uploadHash = '#files/upload';

// Keep only a fixed destination and deadline in this tab. The report grant
// stays on its original history entry and is never carried into the workspace.
const guestEntry = 'studio:open-files';
const accountReturn = 'studio:upload-after-sign-in';

function remember(key: string, ttl: number) {
  try {
    sessionStorage.setItem(key, String(Date.now() + ttl));
  } catch {
    // The Files entry can still offer explicit access if storage is disabled.
  }
}

function consume(key: string) {
  try {
    const deadline = Number(sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
    return deadline > Date.now();
  } catch {
    return false;
  }
}

export function rememberWorkspaceFilesEntry() {
  remember(guestEntry, 60_000);
}

export function takeWorkspaceFilesEntry() {
  return consume(guestEntry) && location.hash === uploadHash;
}

// Bundled SSO returns to the Console root.
export function rememberUploadSignIn() {
  remember(accountReturn, 10 * 60_000);
}

export function restoreUploadAfterSignIn() {
  if (consume(accountReturn) && !location.hash) location.replace(uploadHash);
}
