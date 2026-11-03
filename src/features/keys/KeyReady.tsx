import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Select, Stack, Text } from '@tidbcloud/uikit';
import { CodeBlock } from '@tidbcloud/uikit/biz';
import { IconCopy03, IconKey01 } from '@tidbcloud/uikit/icons';
import { agentLaunchCommand, type LaunchAgent } from './agent-launch';

const terminalSetup = `printf 'Paste your Workspace Key: '; IFS= read -rs WORKSPACE_API_KEY && export WORKSPACE_API_KEY; printf '\\n'`;

export function KeyReady({
  secret,
  copy,
  onCopied,
  onDownload,
  onContinue,
  hidden,
  insufficientAccess,
  accessPending,
  salesPrompt,
  onLaunchCopied,
}: {
  secret: string;
  copy: (value: string) => Promise<boolean>;
  onCopied: () => void;
  onDownload: () => void;
  onContinue: () => void;
  hidden: boolean;
  insufficientAccess: boolean;
  accessPending: boolean;
  salesPrompt?: string;
  onLaunchCopied: (copied: boolean) => void;
}) {
  const [step, setStep] = useState<'setup' | 'key'>('setup');
  const [setupCopied, setSetupCopied] = useState(false);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const [agent, setAgent] = useState<LaunchAgent | 'other'>('pi');
  const directLaunch = Boolean(salesPrompt && !insufficientAccess && agent !== 'other');
  const launchCommand =
    salesPrompt && agent !== 'other' ? agentLaunchCommand(agent, salesPrompt) : '';
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!hidden) stepHeading.current?.focus();
  }, [step, hidden]);
  return (
    <Stack gap="md" className="key-ready">
      {insufficientAccess && (
        <Alert color="yellow" role="alert">
          This key is missing permissions needed for the sales task. You can create another key
          after closing this one.
        </Alert>
      )}
      {accessPending && (
        <Alert color="yellow" role="status">
          Your key was created, but its access is still being applied. If the agent cannot connect,
          try again shortly.
        </Alert>
      )}
      {step === 'setup' ? (
        <>
          <h3 ref={stepHeading} tabIndex={-1} className="key-ready-heading">
            {directLaunch ? '1 of 2 · Start your agent' : '1 of 2 · Prepare your terminal'}
          </h3>
          {salesPrompt && !insufficientAccess && (
            <Select
              label="Your agent"
              value={agent}
              allowDeselect={false}
              data={[
                { value: 'pi', label: 'Pi' },
                { value: 'codex', label: 'Codex CLI' },
                { value: 'claude', label: 'Claude Code' },
                { value: 'other', label: 'Another agent' },
              ]}
              onChange={(value) => {
                if (
                  value === 'pi' ||
                  value === 'codex' ||
                  value === 'claude' ||
                  value === 'other'
                ) {
                  setAgent(value);
                  onLaunchCopied(false);
                }
              }}
            />
          )}
          {directLaunch ? (
            <>
              <Text>
                Copy the command and run it in Bash or Zsh. It starts your agent with the sales task
                and asks for the key privately. The command does not contain your key.
              </Text>
              <Text size="sm">
                Your agent must be installed and signed in. If it asks, allow access to the
                Workspace and its connection guide.
              </Text>
              <Button
                variant="filled"
                onClick={() => {
                  void copy(launchCommand).then((copied) => {
                    if (copied) {
                      onLaunchCopied(true);
                      setStep('key');
                    }
                  });
                }}
              >
                Copy command
              </Button>
              <details>
                <summary>Review command</summary>
                <CodeBlock language="bash" withCopyButton={false}>
                  {launchCommand}
                </CodeBlock>
                <Button
                  onClick={() => {
                    onLaunchCopied(true);
                    setStep('key');
                  }}
                >
                  I copied the command
                </Button>
              </details>
            </>
          ) : (
            <>
              <Text>
                For an agent that inherits your terminal environment, copy and run this command in
                Bash or Zsh. It will wait for your key without displaying it. Then return here for
                the key.
              </Text>
              <CodeBlock
                language="bash"
                withCopyButton={false}
                codeHighlightProps={{ styles: { code: { fontSize: 15, lineHeight: 1.7 } } }}
              >
                {terminalSetup}
              </CodeBlock>
              <Group>
                <Button
                  variant={setupCopied ? 'default' : 'filled'}
                  onClick={() => {
                    void copy(terminalSetup).then((copied) => {
                      if (copied) setSetupCopied(true);
                    });
                  }}
                >
                  Copy setup command
                </Button>
                <Button variant={setupCopied ? 'filled' : 'default'} onClick={() => setStep('key')}>
                  Continue to key
                </Button>
              </Group>
              <Text size="sm">
                Using an agent with secret settings? Continue to the key and add it there as
                WORKSPACE_API_KEY instead.
              </Text>
            </>
          )}
        </>
      ) : (
        <>
          <h3 ref={stepHeading} tabIndex={-1} className="key-ready-heading">
            2 of 2 · Add your key
          </h3>
          <Text>
            {directLaunch
              ? 'Run the copied command in your terminal. When it asks for your key, copy and paste this key, then press Enter. It won’t be visible as you type.'
              : 'When prompted in the terminal, copy and paste this key, then press Enter. It won’t be visible as you type.'}
          </Text>
          <div className="secret-value">
            <IconKey01 size={20} />
            <code>{secret}</code>
          </div>
          <Group>
            <Button
              leftSection={<IconCopy03 size={18} />}
              onClick={() => {
                void copy(secret).then((copied) => {
                  if (copied) onCopied();
                });
              }}
            >
              Copy key
            </Button>
          </Group>
          {!directLaunch && (
            <Text>
              Start a new agent from the same terminal. For example, run <code>pi</code> to start
              Pi, then paste the task on the next screen. You can also add WORKSPACE_API_KEY in your
              agent’s secret settings.
            </Text>
          )}
          <details>
            <summary>Save the key to a file instead</summary>
            <Text size="sm" mt="sm">
              The file contains your key in plain text. Keep it private and out of project
              repositories. Your browser controls where it is saved; downloading it does not connect
              your agent.
            </Text>
            <Button
              mt="sm"
              onClick={() => {
                onDownload();
                setDownloadRequested(true);
              }}
            >
              Download key (.txt)
            </Button>
            {downloadRequested && (
              <Text size="sm" role="status" mt="sm">
                Download requested. Check your browser to confirm where it was saved.
              </Text>
            )}
          </details>
          <Text size="sm">
            Don’t paste the key into chat. Copying it does not connect your agent.
          </Text>
          <Group justify="space-between">
            <Button variant="subtle" onClick={() => setStep('setup')}>
              Back
            </Button>
            <Button variant="filled" onClick={onContinue}>
              {directLaunch ? 'Wait for report' : 'I’ve added the key'}
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
