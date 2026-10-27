import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  applyTheme,
  darkModeQuery,
  readThemePreference,
  themeStorageKey,
} from './theme-preference';
import type { ThemePreference } from './theme-preference';

export function ThemePicker() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyTheme(preference);
    const system = matchMedia(darkModeQuery);
    const updateSystem = () => applyTheme(preference);
    const syncStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey || event.key === null) setPreference(readThemePreference());
    };
    system.addEventListener('change', updateSystem);
    window.addEventListener('storage', syncStorage);
    return () => {
      system.removeEventListener('change', updateSystem);
      window.removeEventListener('storage', syncStorage);
    };
  }, [preference]);

  function selectTheme(value: string) {
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;
    setPreference(value);
    try {
      localStorage.setItem(themeStorageKey, value);
    } catch {
      // Preserve the selection for this session even if storage is blocked.
    }
  }

  const Icon = preference === 'system' ? Monitor : preference === 'dark' ? Moon : Sun;
  return (
    <label className="theme-picker">
      <Icon size={18} aria-hidden="true" />
      <select
        aria-label="Color theme"
        value={preference}
        onChange={(event) => selectTheme(event.target.value)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
