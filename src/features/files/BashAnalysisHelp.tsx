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
            Use this path directly or <Code fz="inherit">"$FILE"</Code> for the selected saved file.
          </>
        ) : (
          'Only the selected saved file is available at this path.'
        )}{' '}
        Other Workspace files are not mounted.
      </Text>
      <details className="bash-usage">
        <summary>How to use Just Bash</summary>
        <Text size="sm">
          Choose an example below, then select Run command or press ⌘ / Ctrl + Enter. Examples
          replace the command without running it. Read Standard output for results and Standard
          error for problems.
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
            Workspace sets <Code fz="inherit">FILE</Code> to this path on every run. Always quote{' '}
            <Code fz="inherit">"$FILE"</Code> to preserve spaces and special characters. This is a
            Workspace variable, not a Bash built-in.
          </Text>
        )}
        <Text size="sm" mt="sm">
          Working directory: <Code fz="inherit">{input.workingDirectory}</Code>. Absolute-path
          examples quote spaces and special characters safely. Use head, tail, grep, wc, awk, sed,
          sort and uniq, including pipes, on this read-only saved-file snapshot. Writes, network
          access, installs and arbitrary programs are unavailable.
        </Text>
        {input.aliases.length > 0 && (
          <Text size="sm" mt="sm">
            Compatibility input:{' '}
            {input.aliases.map((alias) => (
              <Code key={alias} fz="inherit">
                {alias}
              </Code>
            ))}
            . These names refer to the same selected snapshot.
          </Text>
        )}
        <Text size="sm" c="carbon.7" mt="sm">
          Each run reads a fresh saved snapshot. A grep exit code of 1 can simply mean no matching
          lines; check Standard error before treating a nonzero exit as a failure.
        </Text>
      </details>
    </div>
  );
}
