import { useState } from 'react';
import { Button, Stack, Text, Textarea } from '@tidbcloud/uikit';
import { IconCheck, IconCopy03 } from '@tidbcloud/uikit/icons';

const trialInstruction =
  'Follow the official Drive9 skill at https://drive9.ai/studio/skills/drive9-workspace/SKILL.md to find the top US state by sales in the public sample, show the calculation, and save a report I can continue in this project using only the free trial. Give me the read-only Studio link and the local report.';

export function CopyAgentTrial() {
  const [result, setResult] = useState<'idle' | 'copied' | 'manual'>('idle');
  return (
    <Stack className="sign-in-path-action" gap="xs">
      <Button
        fullWidth
        variant="filled"
        leftSection={
          result === 'copied' ? (
            <IconCheck size={18} aria-hidden />
          ) : (
            <IconCopy03 size={18} aria-hidden />
          )
        }
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(trialInstruction);
            setResult('copied');
          } catch {
            setResult('manual');
          }
        }}
      >
        Copy prompt
      </Button>
      {result === 'manual' && (
        <Textarea
          label="Select and copy the prompt into Codex or Pi"
          readOnly
          autosize
          value={trialInstruction}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      <Text size="sm" ta="center" role="status">
        {result === 'copied'
          ? 'Copied. Paste into Codex or Pi in your project.'
          : 'No account needed · 48-hour trial'}
      </Text>
    </Stack>
  );
}
