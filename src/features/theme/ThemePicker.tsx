import { NativeSelect } from '@tidbcloud/uikit';
import { IconMonitor01, IconMoon, IconSun } from '@tidbcloud/uikit/icons';
import { isThemePreference } from './theme-preference';
import { useWorkspaceTheme } from './WorkspaceThemeProvider';

export function ThemePicker() {
  const { preference, setPreference } = useWorkspaceTheme();
  const Icon = preference === 'auto' ? IconMonitor01 : preference === 'dark' ? IconMoon : IconSun;
  return (
    <NativeSelect
      className="theme-picker"
      aria-label="Color theme"
      leftSection={<Icon size={18} />}
      value={preference}
      onChange={(event) => {
        if (isThemePreference(event.currentTarget.value)) setPreference(event.currentTarget.value);
      }}
      data={[
        { value: 'auto', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
    />
  );
}
