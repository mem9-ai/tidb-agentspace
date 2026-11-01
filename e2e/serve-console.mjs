import { createConsoleServer } from '../scripts/serve-console.mjs';
import { access } from 'node:fs/promises';

await access(new URL('../dist/console/index.html', import.meta.url));
const server = createConsoleServer({ apiOrigin: 'http://127.0.0.1:4389' });
// Exercise the same /studio/ asset prefix used by the published Console.
server.prependListener('request', (request) => {
  if (request.url?.startsWith('/studio/')) request.url = request.url.slice('/studio'.length);
});
server.listen(4389, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
