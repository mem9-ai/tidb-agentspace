import { createServer as createViteServer } from 'vite';
import { startServer } from './index.mjs';
const api = await startServer();
const vite = await createViteServer();
await vite.listen();
vite.printUrls();
async function shutdown() {
  await vite.close();
  api.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
