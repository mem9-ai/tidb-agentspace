import { Button, Group, Paper, Stack, Text, ThemeIcon } from '@tidbcloud/uikit';
import { IconArrowRight, IconBrowser, IconTerminal } from '@tidbcloud/uikit/icons';
import { Heading } from '../../ui/WorkspaceHeading';
import { capture } from '../analytics/capture';
import { CopyAgentTrial } from './CopyAgentTrial';

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
    <Button
      variant={guestEnabled ? 'subtle' : 'filled'}
      c={guestEnabled ? 'peacock.8' : undefined}
      rightSection={<IconArrowRight size={16} aria-hidden />}
      onClick={() => {
        capture({ name: 'sign_in_clicked', page: 'workspace' });
        onTiDBLogin();
      }}
    >
      {label}
    </Button>
  );
  return (
    <>
      <div className="sign-in-choices">
        <Paper
          component="section"
          aria-labelledby="agent-path-title"
          className="sign-in-path"
          withBorder
        >
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="peacock" size={36} radius="md" aria-hidden>
              <IconTerminal size={21} color="var(--blue)" />
            </ThemeIcon>
            <div id="agent-path-title">
              <Heading level={2}>With your coding agent</Heading>
            </div>
          </Group>
          <Text component="p">
            Paste the prompt into Claude Code, Cursor, Codex, Pi, or another local coding agent.
            Your agent analyzes the sales sample and gives you a report link.
          </Text>
          <CopyAgentTrial />
        </Paper>
        <Paper
          component="section"
          aria-labelledby="browser-path-title"
          className="sign-in-path"
          withBorder
        >
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="carbon" size={36} radius="md" aria-hidden>
              <IconBrowser size={21} color="var(--text)" />
            </ThemeIcon>
            <div id="browser-path-title">
              <Heading level={2}>In your browser</Heading>
            </div>
          </Group>
          <Text component="p">Explore files and run database queries yourself in Studio.</Text>
          <Stack className="sign-in-path-action" gap="xs">
            {guestEnabled ? (
              <Button
                fullWidth
                variant="default"
                aria-describedby="guest-expiry"
                disabled={guestLoading}
                loading={guestLoading}
                onClick={() => {
                  capture({ name: 'try_clicked', page: 'workspace' });
                  onGuestLogin();
                }}
              >
                Try without an account
              </Button>
            ) : (
              account
            )}
            <Text id="guest-expiry" size="sm" ta="center">
              {guestEnabled
                ? 'Workspace access expires after 24 hours.'
                : 'Guest access is currently unavailable.'}
            </Text>
            {guestError && (
              <Text role="alert" c="red" size="sm">
                {guestError}
              </Text>
            )}
          </Stack>
        </Paper>
      </div>
      {guestEnabled && <Group justify="center">{account}</Group>}
    </>
  );
}
