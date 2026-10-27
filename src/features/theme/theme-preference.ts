export type ThemePreference = 'auto' | 'light' | 'dark';
export const themeStorageKey = 'tidb-workspace-color-scheme';
export const legacyThemeStorageKey = 'tidb-workspace-theme';
type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

// TiUI's persistence hook stores JSON. Migrate once without replacing a newer choice.
export function migrateThemePreference(storage: ThemeStorage): ThemePreference {
  let preference: ThemePreference = 'auto';
  try {
    const saved = storage.getItem(themeStorageKey);
    if (saved !== null) {
      try {
        const parsed: unknown = JSON.parse(saved);
        if (isThemePreference(parsed)) return parsed;
      } catch {
        // Recover malformed values from the previous preference, if available.
      }
    }
    const legacy = storage.getItem(legacyThemeStorageKey);
    if (legacy === 'dark' || legacy === 'light') preference = legacy;
    storage.setItem(themeStorageKey, JSON.stringify(preference));
    storage.removeItem(legacyThemeStorageKey);
  } catch {
    // A blocked store must not prevent rendering or switching themes in this session.
  }
  return preference;
}

export function initialThemePreference(): ThemePreference {
  try {
    return migrateThemePreference(window.localStorage);
  } catch {
    return 'auto';
  }
}
