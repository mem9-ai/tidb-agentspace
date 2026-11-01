import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';

const output = resolve('src/generated/workspace-agent.mjs');
const result = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    minify: false,
    lib: {
      entry: resolve('src/api/agent-sdk.ts'),
      formats: ['es'],
      fileName: () => 'workspace-agent.mjs',
    },
  },
});
const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
const code = outputs.find((item) => item.type === 'chunk' && item.isEntry)?.code;
if (!code) throw new Error('Workspace client bundle was not generated.');
const license = await readFile(resolve('node_modules/openapi-fetch/LICENSE'), 'utf8');
const bundle = `/*\n${license.trim()}\n*/\n${code}`;
if (process.argv.includes('--check')) {
  const existing = await readFile(output, 'utf8').catch(() => '');
  if (existing !== bundle) {
    console.error('Workspace client is out of date. Run npm run agent-sdk:generate.');
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bundle);
}
