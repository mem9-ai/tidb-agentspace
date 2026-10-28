import type { ComponentProps } from 'react';
import { mergeStylesList } from '@tidbcloud/uikit/utils';
import {
  ThemeProvider,
  FONT_FAMILY,
  MONOSPANCED_FONT_FAMILY,
  useTheme,
} from '@tidbcloud/uikit/theme';

// Supported TiUI theme overrides: readability and density only. Colors stay upstream-owned.
export const workspaceDensity = { page: 32, section: 24, control: 48, body: 16, label: 14 };
export const workspaceTheme: NonNullable<ComponentProps<typeof ThemeProvider>['theme']> = {
  fontFamily: FONT_FAMILY,
  fontFamilyMonospace: MONOSPANCED_FONT_FAMILY,
  fontSizes: { xs: '0.8125rem', sm: '0.875rem', md: '1rem', lg: '1.125rem', xl: '1.25rem' },
  lineHeights: { xs: '1.5', sm: '1.6', md: '1.6', lg: '1.6', xl: '1.5' },
  other: { workspace: workspaceDensity },
  components: {
    AppShell: {
      styles: {
        header: {
          backgroundColor: 'var(--mantine-color-carbon-0)',
          borderColor: 'var(--mantine-color-carbon-4)',
        },
        navbar: {
          backgroundColor: 'var(--mantine-color-carbon-0)',
          borderColor: 'var(--mantine-color-carbon-4)',
        },
      },
    },
    Button: {
      defaultProps: { size: 'lg', variant: 'default' },
      styles: { root: { fontSize: 16 }, label: { whiteSpace: 'normal' } },
    },
    ActionIcon: { defaultProps: { size: 44, variant: 'subtle' } },
    Text: { defaultProps: { size: 'md', c: 'carbon.8' } },
    TextInput: { defaultProps: { size: 'xl' } },
    NativeSelect: { defaultProps: { size: 'xl' } },
    Select: { defaultProps: { size: 'xl' } },
    Textarea: {
      defaultProps: { size: 'xl' },
      styles: { input: { fontSize: 16, lineHeight: 1.65 } },
    },
    InputWrapper: {
      styles: { label: { fontSize: 14 }, description: { fontSize: 13 }, error: { fontSize: 14 } },
    },
    Checkbox: {
      defaultProps: { size: 'md' },
      styles: { label: { fontSize: 15, lineHeight: 1.6 }, description: { fontSize: 13 } },
    },
    Badge: {
      defaultProps: { size: 'lg', variant: 'light' },
      styles: { root: { fontSize: 12, textTransform: 'none', fontWeight: 500 } },
    },
    Modal: {
      defaultProps: {
        padding: 24,
        radius: 'md',
        centered: true,
        closeButtonProps: { 'aria-label': 'Close dialog', size: 44 },
      },
      styles: {
        title: { fontSize: 24, fontWeight: 700, lineHeight: 1.4 },
        body: { paddingTop: 8 },
      },
    },
    Drawer: {
      defaultProps: {
        padding: 20,
        closeButtonProps: { 'aria-label': 'Close navigation', size: 44 },
      },
    },
    Table: {
      defaultProps: { horizontalSpacing: 20, verticalSpacing: 20, highlightOnHover: true },
      styles: { table: { fontSize: 15 }, th: { fontSize: 14, fontWeight: 600 } },
    },
    NavLink: {
      styles: {
        root: { minHeight: 48, borderRadius: 8 },
        label: { fontSize: 16 },
        description: { fontSize: 13 },
      },
    },
    Tabs: { styles: { tab: { minHeight: 48, fontSize: 15 } } },
    Menu: { styles: { item: { minHeight: 44, fontSize: 16 } } },
    Alert: { styles: { message: { fontSize: 15, lineHeight: 1.65 }, title: { fontSize: 16 } } },
    Notification: { styles: { description: { fontSize: 15 } } },
    Fieldset: {
      styles: {
        root: {
          backgroundColor: 'var(--mantine-color-carbon-0)',
          borderColor: 'var(--mantine-color-carbon-4)',
        },
      },
    },
    Paper: { defaultProps: { radius: 'md' } },
    Card: { defaultProps: { padding: 24, radius: 'md', withBorder: true } },
  },
};

// TiUI's base component styles are functions. Deep-merging a plain object into
// them discards both sets of styles, so compose through the public TiUI helper.
export function useWorkspaceThemeOverrides() {
  const base = useTheme('light');
  return {
    ...workspaceTheme,
    components: Object.fromEntries(
      Object.entries(workspaceTheme.components ?? {}).map(([name, overrides]) => [
        name,
        overrides?.styles
          ? {
              ...overrides,
              styles: mergeStylesList([base.components[name]?.styles, overrides.styles]),
            }
          : overrides,
      ]),
    ),
  };
}
