import { createServer as createViteServer } from 'vite';
import { startServer } from './index.mjs';
const api = await startServer();
const vite = await createViteServer();
await vite.listen();
vite.printUrls();
async function shutdown() {
  await vite.close();
  await new Promise((resolve) => api.close(resolve));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
