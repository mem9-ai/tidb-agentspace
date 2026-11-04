import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { publicDiscoveryPlugin } from './scripts/public-discovery.mjs';
export default defineConfig({
  publicDir: 'console/public',
  plugins: [react(), publicDiscoveryPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  worker: { format: 'iife', rollupOptions: { output: { inlineDynamicImports: true } } },
  build: {
    outDir: 'dist/console',
    rollupOptions: { input: { app: 'index.html', discovery: 'src/discovery.ts' } },
  },
});
