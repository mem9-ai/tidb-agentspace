import { createElement, lazy, Suspense } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownNode = { type: string; lang?: string | null; children?: MarkdownNode[] };

export function limitMermaidDiagrams() {
  return (tree: MarkdownNode) => {
    let count = 0;
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid' && ++count > 8)
        node.lang = 'mermaid-over-limit';
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
        const child = node.children?.[index];
        if (child) pending.push(child);
      }
    }
  };
}

const MermaidDiagram = lazy(() => import('./MermaidDiagram'));

function Mermaid({ source }: { source: string }) {
  return createElement(
    Suspense,
    { fallback: createElement('p', { role: 'status' }, 'Loading diagram…') },
    createElement(MermaidDiagram, { source }),
  );
}

export function MarkdownPreview({ content }: { content: string }) {
  return createElement(Markdown, {
    children: content,
    remarkPlugins: [remarkGfm, limitMermaidDiagrams],
    skipHtml: true,
    // File contents are untrusted. No HTML execution or automatic remote image requests.
    urlTransform: (url, key) => (key === 'href' && /^(https?:\/\/|mailto:)/i.test(url) ? url : ''),
    components: {
      pre: ({ node, children }) => {
        const code = node?.children.find(
          (child) => child.type === 'element' && child.tagName === 'code',
        );
        if (code?.type === 'element' && Array.isArray(code.properties.className)) {
          const classes = code.properties.className.map((value) => String(value).toLowerCase());
          if (
            classes.includes('language-mermaid') ||
            classes.includes('language-mermaid-over-limit')
          ) {
            const source = code.children
              .filter((child) => child.type === 'text')
              .map((child) => child.value)
              .join('');
            if (classes.includes('language-mermaid-over-limit'))
              return createElement(
                'div',
                { className: 'mermaid-preview' },
                createElement(
                  'p',
                  { role: 'status' },
                  'Only the first 8 diagrams are rendered in this file.',
                ),
                createElement(
                  'details',
                  null,
                  createElement('summary', null, 'View diagram source'),
                  createElement('pre', null, createElement('code', null, source)),
                ),
              );
            return createElement(Mermaid, { source });
          }
        }
        return createElement('pre', null, children);
      },
      a: ({ href, children }) =>
        href
          ? createElement('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children)
          : createElement('span', null, children),
      img: ({ alt }) =>
        createElement(
          'span',
          { className: 'markdown-image-label' },
          `Image: ${alt || 'Untitled image'}`,
        ),
      input: ({ checked }) =>
        createElement(
          'span',
          { role: 'img', 'aria-label': checked ? 'Completed task' : 'Incomplete task' },
          checked ? '☑' : '☐',
        ),
    },
  });
}
