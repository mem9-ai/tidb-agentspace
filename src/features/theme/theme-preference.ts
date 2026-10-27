export type ThemePreference = 'system' | 'light' | 'dark';

export const themeStorageKey = 'tidb-workspace-theme';
export const darkModeQuery = '(prefers-color-scheme: dark)';

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(themeStorageKey);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // The theme still works when browser storage is unavailable.
  }
  return 'system';
}

export function applyTheme(preference: ThemePreference) {
  const dark =
    preference === 'dark' || (preference === 'system' && matchMedia(darkModeQuery).matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#11151c' : '#f6f7f9');
}
