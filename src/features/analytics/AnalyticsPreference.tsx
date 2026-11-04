import { Anchor, Button, Group, Text } from '@tidbcloud/uikit';
import { useState } from 'react';
import { analyticsDisabled, setAnalyticsDisabled } from './capture';

export function AnalyticsPreference() {
  const [disabled, setDisabled] = useState(analyticsDisabled);
  return (
    <Group gap="sm" p="md" justify="center">
      <Text size="sm">Optional usage analytics: {disabled ? 'off' : 'on'}</Text>
      <Button
        variant="subtle"
        size="xs"
        onClick={() => {
          const next = !disabled;
          setDisabled(next);
          void setAnalyticsDisabled(next);
        }}
      >
        {disabled ? 'Enable' : 'Turn off'}
      </Button>
      <Anchor size="sm" href={import.meta.env.BASE_URL + 'discover/privacy/'}>
        What we collect
      </Anchor>
    </Group>
  );
}
