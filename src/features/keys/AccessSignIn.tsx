import { useState } from 'react';
import { Button } from '@tidbcloud/uikit';
import { signInGlobal } from '../../api/client';
import { WorkspaceApiError } from '../../api/transport';

export function requiresAccessSignIn(error: unknown): boolean {
  return error instanceof WorkspaceApiError && error.status === 401;
}

export function AccessSignIn({ onError }: { onError: (error: Error) => void }) {
  const [busy, setBusy] = useState(false);
  async function signIn() {
    setBusy(true);
    try {
      await signInGlobal();
    } catch {
      onError(new Error('Could not open sign-in. Try again.'));
      setBusy(false);
    }
  }
  return (
    <Button type="button" variant="filled" loading={busy} onClick={() => void signIn()}>
      Sign in again
    </Button>
  );
}
