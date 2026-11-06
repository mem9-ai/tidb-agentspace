import { useState } from 'react';
import { Button, Stack, Text, Textarea } from '@tidbcloud/uikit';
import { IconCheck, IconCopy03 } from '@tidbcloud/uikit/icons';

const skillUrl = 'https://drive9.ai/studio/skills/drive9-workspace/SKILL.md';
const trialInstruction = `Follow the official TiDB Agent Workspace skill at ${skillUrl} to find the top US state by sales in the public sample, show the calculation, and save a report I can continue in this project using only the free trial. Give me the read-only Studio link and the local report. If this is the first version, ask if I want to add the leading state’s top product in this chat.`;

export function TrialPrompt({
  leadingState,
  sampleSales,
}: {
  leadingState?: string;
  sampleSales?: string;
}) {
  const followUp = leadingState !== undefined;
  const compact = followUp || sampleSales !== undefined;
  const prompt = sampleSales
    ? `Follow the TiDB Agent Workspace skill at ${skillUrl} to continue this public sales report. What share of total sales comes from the top two states? Use these figures from the report: ${sampleSales}. Show the calculation in chat and add it to this project's saved local report if available. Use the existing sample and report. Reply in the language we have been using. In a new chat, use ${navigator.language}.`
    : followUp
      ? `Follow ${skillUrl} in the local project that created my TiDB Agent Workspace sales report. Add the top product by sales in ${leadingState} and its share of state sales to the same report, then give me the updated Studio link.`
      : trialInstruction;
  const [result, setResult] = useState<'idle' | 'copied' | 'manual'>('idle');
  return (
    <Stack className={compact ? undefined : 'sign-in-path-action'} gap="xs">
      <Button
        fullWidth={!compact}
        w={compact ? 'fit-content' : undefined}
        variant={sampleSales ? 'default' : 'filled'}
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
        {sampleSales ? 'Copy next question' : followUp ? 'Copy follow-up' : 'Copy prompt'}
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
            ? sampleSales
              ? 'Copied. Paste into your agent chat to continue this report.'
              : 'Copied. Paste it into your project chat.'
            : 'No account needed · 48-hour trial'}
        </Text>
      )}
    </Stack>
  );
}
