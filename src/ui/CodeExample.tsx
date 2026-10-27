import { ActionIcon, Group, Text } from '@tidbcloud/uikit';
import { CodeBlock } from '@tidbcloud/uikit/biz';
import { IconCopy03 } from '@tidbcloud/uikit/icons';

export function CodeExample({
  value,
  copy,
  label,
}: {
  value: string;
  copy: (value: string) => void;
  label?: string;
}) {
  const language =
    label === 'JSON'
      ? 'json'
      : label === 'JAVASCRIPT'
        ? 'javascript'
        : label === 'PYTHON'
          ? 'python'
          : 'bash';
  return (
    <div className="code-example">
      <Group justify="space-between" gap={12} mb={8}>
        <Text size="sm" fw={600}>
          {label || 'Code'}
        </Text>
        <ActionIcon aria-label="Copy code" onClick={() => copy(value)}>
          <IconCopy03 size={18} />
        </ActionIcon>
      </Group>
      <CodeBlock
        language={language}
        withCopyButton={false}
        codeHighlightProps={{ styles: { code: { fontSize: 15, lineHeight: 1.7 } } }}
      >
        {value}
      </CodeBlock>
    </div>
  );
}
