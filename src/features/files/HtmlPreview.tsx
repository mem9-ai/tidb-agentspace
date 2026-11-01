import { useMemo } from 'react';
import { Text, useComputedColorScheme, useMantineTheme } from '@tidbcloud/uikit';
import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';

const blockedTags = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'base',
  'form',
  'meta',
  'link',
  'template',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
]);
const blockedAttributes = new Set(['href', 'action', 'formaction', 'ping', 'srcset']);

function previewDocument(
  content: string,
  theme: 'light' | 'dark',
  background: string,
  text: string,
) {
  // parse5 never creates browser DOM nodes, so parsing cannot initiate resource requests.
  const tree = parse(content);
  const pending: DefaultTreeAdapterTypes.ParentNode[] = [tree];
  while (pending.length) {
    const parent = pending.pop();
    if (!parent) break;
    parent.childNodes = parent.childNodes.filter((child) => {
      if (!('tagName' in child)) return true;
      if (blockedTags.has(child.tagName.toLowerCase())) return false;
      child.attrs = child.attrs.filter(
        (attribute) => !attribute.name.startsWith('on') && !blockedAttributes.has(attribute.name),
      );
      pending.push(child);
      return true;
    });
  }
  const policy =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
  return serialize(tree).replace(
    '<head>',
    `<head><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html { color-scheme: ${theme}; background: ${background}; color: ${text}; }</style>`,
  );
}

// HTML is untrusted file content. Sanitize navigation as well as active markup: the
// sandbox and CSP provide independent isolation and prevent external resource requests.
export default function HtmlPreview({ content }: { content: string }) {
  const theme = useComputedColorScheme('light');
  const palette = useMantineTheme();
  const background = palette.colors.carbon[0];
  const text = palette.colors.carbon[8];
  const document = useMemo(
    () => previewDocument(content, theme, background, text),
    [content, theme, background, text],
  );

  return (
    <div className="file-html-preview">
      <Text size="sm" c="carbon.7" mb={12}>
        Static preview: scripts, links, and external resources are disabled.
      </Text>
      <iframe title="HTML preview" sandbox="" srcDoc={document} />
    </div>
  );
}
