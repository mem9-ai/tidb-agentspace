import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from '@tidbcloud/uikit';
import { ThemeProvider } from '@tidbcloud/uikit/theme';
import { useWorkspaceThemeOverrides } from '../../ui/workspace-theme';
import { initialThemePreference, isThemePreference, themeStorageKey } from './theme-preference';
import type { ThemePreference } from './theme-preference';

const ThemeContext = createContext<{
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
} | null>(null);

export function WorkspaceThemeProvider({ children }: { children: ReactNode }) {
  const theme = useWorkspaceThemeOverrides();
  const [initial] = useState(initialThemePreference);
  const { colorScheme, setColorScheme } = useColorScheme(initial, {
    key: themeStorageKey,
    getInitialValueInEffect: false,
  });
  const preference = isThemePreference(colorScheme) ? colorScheme : 'auto';
  return (
    <ThemeContext.Provider value={{ preference, setPreference: setColorScheme }}>
      <ThemeProvider
        colorScheme={preference}
        theme={theme}
        notifications={{ position: 'bottom-right' }}
      >
        {children}
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}

export function useWorkspaceTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('WorkspaceThemeProvider is required.');
  return theme;
}
