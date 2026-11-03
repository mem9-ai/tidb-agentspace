import { Button, Stack, Text } from '@tidbcloud/uikit';

type SignInChoicesProps = {
  label: string;
  onTiDBLogin: () => void;
  onGuestLogin: () => void;
  guestEnabled: boolean;
  guestLoading: boolean;
  guestError: string;
};

export function SignInChoices({
  label,
  onTiDBLogin,
  onGuestLogin,
  guestEnabled,
  guestLoading,
  guestError,
}: SignInChoicesProps) {
  const account = (
    <Button fullWidth size="lg" variant={guestEnabled ? 'default' : 'filled'} onClick={onTiDBLogin}>
      {label}
    </Button>
  );
  return (
    <Stack className="sign-in-choices" gap="sm">
      {!guestEnabled && account}
      <Button
        fullWidth
        size="lg"
        variant={guestEnabled ? 'filled' : 'default'}
        h="auto"
        py="sm"
        aria-label="Try without an account"
        aria-describedby={guestEnabled ? 'guest-expiry' : 'guest-expiry guest-access-note'}
        disabled={!guestEnabled || guestLoading}
        loading={guestLoading}
        onClick={onGuestLogin}
      >
        <Stack component="span" gap={0} align="center">
          <span>Try without an account</span>
          <Text id="guest-expiry" component="span" size="sm" fw={400} c="inherit">
            Workspace access expires after 24 hours
          </Text>
        </Stack>
      </Button>
      {!guestEnabled && (
        <Text id="guest-access-note" size="sm" ta="center">
          Trying without an account is coming soon.
        </Text>
      )}
      {guestEnabled && account}
      {guestError && (
        <Text role="alert" c="red" size="sm">
          {guestError}
        </Text>
      )}
    </Stack>
  );
}
