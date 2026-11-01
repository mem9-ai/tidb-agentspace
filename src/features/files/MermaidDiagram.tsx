import { useComputedColorScheme, useMantineTheme } from '@tidbcloud/uikit';
import { useEffect, useRef, useState } from 'react';
import frameUrl from './MermaidFrame.ts?worker&url';

const maxDiagramBytes = 20_000;

export default function MermaidDiagram({ source }: { source: string }) {
  const theme = useComputedColorScheme('light');
  const palette = useMantineTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef(crypto.randomUUID());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [height, setHeight] = useState(200);
  const tooLarge = new TextEncoder().encode(source).length > maxDiagramBytes;
  const hasImageNode =
    !tooLarge &&
    source
      .split(/@\s*\{/)
      .slice(1)
      .some((part) => /\bimg\s*:/i.test(part.split('}', 1)[0]));
  const handshake = () => frame.current?.contentWindow?.postMessage({ type: 'handshake' }, '*');
  useEffect(() => {
    if (tooLarge || hasImageNode) return;
    setStatus('loading');
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== 'object'
      )
        return;
      const message = event.data;
      if (!('type' in message) || !('channel' in message) || message.channel !== channel.current)
        return;
      if (message.type === 'mermaid-init')
        frame.current?.contentWindow?.postMessage(
          { type: 'render', source, theme, channel: channel.current },
          '*',
        );
      else if (message.type === 'mermaid-ready') setStatus('ready');
      else if (message.type === 'mermaid-error') setStatus('error');
      else if (
        message.type === 'mermaid-height' &&
        'height' in message &&
        typeof message.height === 'number' &&
        Number.isFinite(message.height)
      )
        setHeight(Math.min(1200, Math.max(120, message.height)));
    };
    window.addEventListener('message', handleMessage);
    handshake();
    const timer = window.setTimeout(
      () => setStatus((current) => (current === 'loading' ? 'error' : current)),
      15000,
    );
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', handleMessage);
    };
  }, [source, theme, tooLarge, hasImageNode]);
  const script = new URL(frameUrl, window.location.href);
  const scriptUrl = script.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const documentHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptUrl}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:${palette.colors.carbon[0]};color-scheme:${theme}}body{padding:12px;overflow:auto;box-sizing:border-box}svg{display:block;max-width:100%;height:auto;margin:auto}</style></head><body><script src="${scriptUrl}" data-channel="${channel.current}"></script></body></html>`;
  return (
    <div className="mermaid-preview">
      {!tooLarge && !hasImageNode && status !== 'error' && (
        <iframe
          key={theme + source}
          ref={frame}
          sandbox="allow-scripts"
          title="Mermaid diagram"
          srcDoc={documentHtml}
          onLoad={handshake}
          style={{ height }}
        />
      )}
      {status === 'loading' && !tooLarge && !hasImageNode && (
        <p role="status">Rendering diagram…</p>
      )}
      {(tooLarge || hasImageNode || status === 'error') && (
        <div role="status" className="mermaid-preview-error">
          {tooLarge
            ? 'This diagram exceeds the 20 KB preview limit.'
            : hasImageNode
              ? 'Images inside Mermaid diagrams are not supported. View the source to see the diagram.'
              : 'This diagram could not be rendered. Check its Mermaid syntax.'}
        </div>
      )}
      <details>
        <summary>View diagram source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}
