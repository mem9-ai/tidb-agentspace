import { useState } from 'react';
import { Button, Stack, Text, Textarea } from '@tidbcloud/uikit';

const trialInstruction =
  'Follow the official Drive9 skill at https://drive9.ai/studio/skills/drive9-workspace/SKILL.md to find the top US state by sales in the public sample, show the calculation, and save a report I can continue in this project using only the free trial.';

export function CopyAgentTrial() {
  const [result, setResult] = useState<'idle' | 'copied' | 'manual'>('idle');
  return (
    <>
      <Button
        fullWidth
        size="lg"
        variant="default"
        h="auto"
        py="sm"
        aria-label="Copy for my agent"
        aria-describedby="agent-report-description"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(trialInstruction);
            setResult('copied');
          } catch {
            setResult('manual');
          }
        }}
      >
        <Stack component="span" gap={0} align="center">
          <span>Copy for my agent</span>
          <Text id="agent-report-description" component="span" size="sm" fw={400} c="inherit">
            Run a free sales report in Codex or Pi
          </Text>
        </Stack>
      </Button>
      {result === 'copied' && (
        <Text size="sm" ta="center" role="status">
          Copied. Paste into Codex or Pi in your project.
        </Text>
      )}
      {result === 'manual' && (
        <Textarea
          label="Copy this instruction into Codex or Pi"
          readOnly
          autosize
          value={trialInstruction}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </>
  );
}
