import { createServer as createViteServer } from 'vite';
import { startRustApi } from '../scripts/start-rust-api.mjs';
const api = await startRustApi({
  configFile: process.env.WORKSPACE_BACKEND_CONFIG,
  binary: process.env.WORKSPACE_BACKEND_BINARY,
});
const vite = await createViteServer();
await vite.listen();
vite.printUrls();
async function shutdown() {
  await vite.close();
  await api.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
