import { useState } from 'react';
import { Button, Stack, Text, Textarea } from '@tidbcloud/uikit';
import { IconCheck, IconCopy03 } from '@tidbcloud/uikit/icons';

const skillUrl = 'https://drive9.ai/studio/skills/drive9-workspace/SKILL.md';
const trialInstruction = `Follow the official Drive9 skill at ${skillUrl} to find the top US state by sales in the public sample, show the calculation, and save a report I can continue in this project using only the free trial. Give me the read-only Studio link and the local report. If this is the first version, ask if I want to add the leading state’s top product in this chat.`;

export function TrialPrompt({
  leadingState,
  privateCsv = false,
}: {
  leadingState?: string;
  privateCsv?: boolean;
}) {
  const followUp = leadingState !== undefined;
  const compact = followUp || privateCsv;
  const prompt = privateCsv
    ? `Follow ${skillUrl} to analyze my own CSV in this project. Resume the existing private CSV workspace if one is bound. Otherwise ask which CSV to upload to a free 24-hour workspace. Use only the file I select, save the analysis locally, and give me the report.`
    : followUp
      ? `Follow ${skillUrl} in the local project that created my Drive9 sales report. Add the top product by sales in ${leadingState} and its share of state sales to the same report, then give me the updated Studio link.`
      : trialInstruction;
  const [result, setResult] = useState<'idle' | 'copied' | 'manual'>('idle');
  return (
    <Stack className={compact ? undefined : 'sign-in-path-action'} gap="xs">
      <Button
        fullWidth={!compact}
        w={compact ? 'fit-content' : undefined}
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
            await navigator.clipboard.writeText(prompt);
            setResult('copied');
          } catch {
            setResult('manual');
          }
        }}
      >
        {privateCsv ? 'Copy prompt for my CSV' : followUp ? 'Copy follow-up' : 'Copy prompt'}
      </Button>
      {result === 'manual' && (
        <Textarea
          label={
            followUp
              ? 'Select and copy the follow-up for your agent'
              : 'Select and copy the prompt for your coding agent'
          }
          readOnly
          autosize
          value={prompt}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      {(!compact || result === 'copied') && (
        <Text size="sm" ta={compact ? 'left' : 'center'} role="status">
          {result === 'copied'
            ? 'Copied. Paste it into your project chat.'
            : 'No account needed · 48-hour trial'}
        </Text>
      )}
    </Stack>
  );
}
