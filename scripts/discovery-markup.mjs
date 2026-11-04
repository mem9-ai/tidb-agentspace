import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { Anchor, Button, Group, Paper, Text, Typography } from '@tidbcloud/uikit';
import { ThemeProvider } from '@tidbcloud/uikit/theme';
import { useWorkspaceThemeOverrides } from '../src/ui/workspace-theme.ts';

function DiscoveryTheme({ children }) {
  const theme = useWorkspaceThemeOverrides();
  return h(ThemeProvider, { colorScheme: 'auto', theme }, children);
}

// Build-time rendering of owned editorial content. Controls and theme stay TiUI-owned.
function content(node, key) {
  if (node.nodeName === '#text') return node.value;
  if (!node.tagName) return null;
  const attributes = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
  const children = (node.childNodes || []).map(content);
  const props = {
    key,
    ...(attributes.id ? { id: attributes.id } : {}),
    ...(attributes.role ? { role: attributes.role } : {}),
  };
  if (node.tagName === 'h2')
    return h(
      Typography,
      {
        ...props,
        component: 'h2',
        variant: 'headline-lg',
        mt: node.parentNode?.tagName === 'section' ? 0 : 28,
        mb: 12,
      },
      children,
    );
  if (node.tagName === 'p')
    return h(
      Text,
      {
        ...props,
        component: 'p',
        size: 'lg',
        lh: 1.65,
        my: 16,
        className: attributes.class === 'lead' ? 'discovery-lead' : undefined,
      },
      children,
    );
  if (node.tagName === 'section')
    return h(Paper, { ...props, withBorder: true, radius: 'md', p: 'lg' }, children);
  if (node.tagName === 'button')
    return h(Button, { ...props, type: 'button', variant: 'filled' }, children);
  if (node.tagName === 'a') return h(Anchor, { ...props, href: attributes.href }, children);
  return h(
    node.tagName,
    {
      ...props,
      ...(attributes.class === 'cards' ? { className: 'discovery-cards' } : {}),
      ...(attributes.role ? { role: attributes.role } : {}),
    },
    children,
  );
}

export function discoveryMarkup(page, base) {
  const link = (text, path) => h(Anchor, { key: path, href: base + path }, text);
  return renderToStaticMarkup(
    h(
      DiscoveryTheme,
      null,
      h(
        'nav',
        { className: 'discovery-shell discovery-nav', 'aria-label': 'Main' },
        h(Anchor, { href: base + 'discover/', fw: 700, size: 'xl' }, 'Drive9 Workspace'),
        h(
          Group,
          { gap: 'lg' },
          link('Get started', 'discover/get-started/'),
          link('Sales guide', 'discover/analyze-sales-data/'),
          link('API', 'discover/api/'),
        ),
      ),
      h(
        'main',
        { className: 'discovery-shell discovery-main' },
        h(Text, { size: 'sm', fw: 600 }, 'Files · PostgreSQL · Agents'),
        h(
          Typography,
          {
            component: 'h1',
            variant: 'headline-lg',
            fz: 'clamp(38px, 6vw, 64px)',
            lh: 1.12,
            mt: 24,
            mb: 32,
            maw: 900,
          },
          page.heading,
        ),
        h(
          'div',
          { className: 'discovery-copy' },
          parseFragment(page.body.replaceAll('{{BASE}}', base)).childNodes.map(content),
        ),
        page.page !== 'privacy' &&
          h(
            'div',
            { className: 'discovery-trial' },
            h(
              Button,
              {
                component: 'a',
                href: base,
                variant: 'filled',
                size: 'lg',
                'data-analytics': 'try',
              },
              'Try without an account',
            ),
            h(
              Text,
              { size: 'sm', mt: 'md' },
              'Temporary workspace access lasts 24 hours. Availability depends on the deployment.',
            ),
          ),
      ),
      h(
        'footer',
        { className: 'discovery-shell discovery-footer' },
        h(
          Group,
          { gap: 'lg' },
          link('Privacy and analytics choices', 'discover/privacy/'),
          link('Open Console', ''),
        ),
      ),
    ),
  );
}
