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
        disabled={!guestEnabled || guestLoading}
        loading={guestLoading}
        onClick={onGuestLogin}
      >
        Continue as Guest
      </Button>
      <Text size="sm" ta="center">
        {guestEnabled
          ? 'Guest access ends 24 hours after creation. Your workspace becomes inaccessible, but cloud resources may remain.'
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
