import { createElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownPreview({ content }: { content: string }) {
  return createElement(Markdown, {
    children: content,
    remarkPlugins: [remarkGfm],
    skipHtml: true,
    // File contents are untrusted. No HTML execution or automatic remote image requests.
    urlTransform: (url, key) => (key === 'href' && /^(https?:\/\/|mailto:)/i.test(url) ? url : ''),
    components: {
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
