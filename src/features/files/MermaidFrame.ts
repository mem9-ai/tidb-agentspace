import mermaid from 'mermaid';

// This script runs only in an opaque-origin, network-restricted sandboxed iframe.
const channel = document.currentScript?.getAttribute('data-channel');
const reply = (message: object) => window.parent.postMessage({ ...message, channel }, '*');
let started = false;
window.addEventListener('message', async (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
  const request = event.data;
  if (!('type' in request)) return;
  if (request.type === 'handshake') {
    reply({ type: 'mermaid-init' });
    return;
  }
  if (
    started ||
    request.type !== 'render' ||
    !('channel' in request) ||
    request.channel !== channel ||
    !('source' in request) ||
    typeof request.source !== 'string' ||
    !('theme' in request) ||
    (request.theme !== 'light' && request.theme !== 'dark')
  )
    return;
  started = true;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: request.theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'Inter, sans-serif',
      htmlLabels: false,
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'htmlLabels',
      ],
      maxTextSize: 20000,
      maxEdges: 200,
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render('mermaid-diagram', request.source);
    // A template is inert until inserted. Mermaid may preserve images in HTML labels;
    // remove them and active elements before the browser can load or execute them.
    const template = document.createElement('template');
    template.innerHTML = svg;
    template.content
      .querySelectorAll('img, image, script, iframe, object, embed, link')
      .forEach((node) => node.remove());
    template.content.querySelectorAll('*').forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (
          /^on/i.test(attribute.name) ||
          (node.localName === 'a' && /^(href|xlink:href)$/i.test(attribute.name))
        )
          node.removeAttribute(attribute.name);
      }
    });
    const diagram = template.content.querySelector('svg');
    const width = diagram?.viewBox.baseVal.width;
    if (diagram && width && Number.isFinite(width)) {
      diagram.style.setProperty('max-width', 'none', 'important');
      diagram.style.width = `${Math.min(10000, Math.ceil(width))}px`;
    }
    document.body.replaceChildren(template.content);
    document.addEventListener('click', (event) => event.preventDefault(), true);
    const report = () =>
      reply({
        type: 'mermaid-height',
        height: document.body.scrollHeight,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      });
    new ResizeObserver(report).observe(document.body);
    report();
    reply({ type: 'mermaid-ready' });
  } catch {
    reply({ type: 'mermaid-error' });
  }
});
