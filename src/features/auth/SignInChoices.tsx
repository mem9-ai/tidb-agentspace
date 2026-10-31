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
  return (
    <Stack className="sign-in-choices" gap="sm">
      <Button fullWidth size="lg" onClick={onTiDBLogin}>
        {label}
      </Button>
      <Button
        fullWidth
        size="lg"
        variant="default"
        h="auto"
        py="sm"
        aria-label="Continue as Guest"
        aria-describedby="guest-expiry guest-access-note"
        disabled={!guestEnabled || guestLoading}
        loading={guestLoading}
        onClick={onGuestLogin}
      >
        <Stack component="span" gap={0} align="center">
          <span>Continue as Guest</span>
          <Text id="guest-expiry" component="span" size="sm" fw={400}>
            Workspace access expires after 24 hours
          </Text>
        </Stack>
      </Button>
      <Text id="guest-access-note" size="sm" ta="center">
        {guestEnabled
          ? 'Cloud resources may remain after access ends.'
          : '24-hour Guest access is coming soon.'}
      </Text>
      {guestError && (
        <Text role="alert" c="red" size="sm">
          {guestError}
        </Text>
      )}
    </Stack>
  );
}
