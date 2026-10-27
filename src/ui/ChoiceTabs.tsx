import type { ReactNode } from 'react';
import { Tabs } from '@tidbcloud/uikit';

export function ChoiceTabs({
  value,
  onChange,
  options,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  children: ReactNode;
}) {
  return (
    <Tabs
      value={encodeURIComponent(value)}
      onChange={(next) => {
        const option = options.find((item) => encodeURIComponent(item) === next);
        if (option !== undefined) onChange(option);
      }}
      className="choice-tabs"
    >
      <Tabs.List>
        {options.map((option) => (
          <Tabs.Tab value={encodeURIComponent(option)} key={option}>
            {option}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {options.map((option) => (
        <Tabs.Panel value={encodeURIComponent(option)} key={option} pt={24}>
          {option === value ? children : null}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
