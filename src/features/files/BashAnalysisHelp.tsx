import { ActionIcon, Button, Code, CopyButton, Group, Text } from '@tidbcloud/uikit';
import { IconCheck, IconCopy03 } from '@tidbcloud/uikit/icons';
import { bashSamples, type BashInput } from './bash-analysis';

export function BashAnalysisHelp({
  id,
  input,
  busy,
  onSample,
}: {
  id: string;
  input: BashInput;
  busy: boolean;
  onSample: (command: string) => void;
}) {
  return (
    <div id={id} className="bash-analysis-help">
      <Group gap="xs" wrap="wrap">
        <Text component="span" size="sm" fw={600}>
          Input file
        </Text>
        <Code className="analysis-input-path" fz="md">
          {input.path}
        </Code>
        <CopyButton value={input.path}>
          {({ copied, copy }) => (
            <ActionIcon
              aria-label={copied ? 'Input path copied' : 'Copy input file path'}
              title={copied ? 'Input path copied' : 'Copy input file path'}
              onClick={copy}
            >
              {copied ? <IconCheck size={18} /> : <IconCopy03 size={18} />}
            </ActionIcon>
          )}
        </CopyButton>
      </Group>
      <Text size="sm" c="carbon.7">
        {input.fileVariable === 'FILE' ? (
          <>
            Read-only access to this file. Use its full path or <Code fz="inherit">"$FILE"</Code>.
          </>
        ) : (
          'Read-only access to this file. Use its full path.'
        )}
      </Text>
      <details className="bash-usage">
        <summary>How to use Just Bash</summary>
        <Text size="sm">
          Examples only fill the editor. Click Run command or press ⌘ / Ctrl + Enter to execute.
        </Text>
        <Group gap="xs" mt="sm">
          {bashSamples(input.path, input.fileVariable).map((example) => (
            <Button
              key={example.label}
              variant="subtle"
              disabled={busy}
              onClick={() => onSample(example.value)}
            >
              {example.label}
            </Button>
          ))}
        </Group>
        {input.fileVariable === 'FILE' && (
          <Text size="sm" mt="sm">
            Workspace sets <Code fz="inherit">FILE</Code> to the full path above on each run. Keep
            the double quotes in <Code fz="inherit">"$FILE"</Code> for spaces and special
            characters.
          </Text>
        )}
        <details className="bash-usage">
          <summary>Runtime and compatibility details</summary>
          <Text size="sm" mt="sm">
            Each run reads a fresh copy of this saved file. Other files are unavailable, and
            commands cannot modify the original. Network access, installations and arbitrary
            programs are unavailable.
          </Text>
          <Text size="sm" mt="sm">
            Relative paths start at <Code fz="inherit">{input.workingDirectory}</Code> in this
            analysis environment. Supported commands include head, tail, grep, wc, awk and sed, with
            pipes. See Editor tools → Limits for execution limits.
          </Text>
          <Text size="sm" mt="sm">
            Read Standard output for results and Standard error for command errors. A grep exit code
            of 1 can mean no matching lines.
          </Text>
          {input.aliases.length > 0 && (
            <>
              <Text size="sm" fw={600} mt="sm">
                Legacy alias for older commands
              </Text>
              <Group gap="xs" mt="xs">
                {input.aliases.map((alias) => (
                  <Code key={alias} fz="inherit">
                    {alias}
                  </Code>
                ))}
              </Group>
              <Text size="sm" mt="xs">
                This temporary alias always points to the selected file shown above. It does not
                create or overwrite a file in your File System.
              </Text>
            </>
          )}
        </details>
      </details>
    </div>
  );
}
