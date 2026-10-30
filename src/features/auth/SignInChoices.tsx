import { Button, Stack, Text } from '@tidbcloud/uikit';

type SignInChoicesProps = {
  label: string;
  onTiDBLogin: () => void;
};

export function SignInChoices({ label, onTiDBLogin }: SignInChoicesProps) {
  return (
    <Stack className="sign-in-choices" gap="sm">
      <Button fullWidth size="lg" onClick={onTiDBLogin}>
        {label}
      </Button>
      <Button fullWidth size="lg" variant="default" disabled>
        Continue as Guest
      </Button>
      <Text size="sm" ta="center">
        24-hour Guest access is coming soon.
      </Text>
    </Stack>
  );
}
