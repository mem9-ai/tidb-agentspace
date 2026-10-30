import { createConsoleServer } from '../scripts/serve-console.mjs';
import { access } from 'node:fs/promises';

await access(new URL('../dist/console/index.html', import.meta.url));
const server = createConsoleServer({ apiOrigin: 'http://127.0.0.1:4389' });
server.listen(4389, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
