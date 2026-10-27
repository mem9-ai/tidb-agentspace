import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi } from './build-api.mjs';

export async function packageRuntime({ root, destination, sourceSha }) {
  if (!/^[a-f0-9]{40}$/i.test(sourceSha || '') || /^0+$/.test(sourceSha))
    throw new Error('A full source commit SHA is required.');
  const temporary = await mkdtemp(resolve(tmpdir(), 'tidb-runtime-'));
  try {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const nodeVersion = (await readFile(resolve(root, '.node-version'), 'utf8')).trim();
    await mkdir(destination, { recursive: true });
    const artifacts = [];
    for (const kind of ['api', 'console']) {
      const staged = resolve(temporary, kind);
      if (kind === 'api') await buildApi({ root, destination: staged });
      else {
        await mkdir(staged);
        await cp(resolve(root, 'dist/console'), resolve(staged, 'static'), { recursive: true });
        await cp(resolve(root, 'scripts/serve-console.mjs'), resolve(staged, 'serve-console.mjs'));
      }
      const info = {
        sourceSha,
        version: pkg.version,
        nodeVersion,
        component: kind,
        audience: 'internal-local-demo',
        deployed: false,
      };
      await writeFile(resolve(staged, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
      const instructions =
        kind === 'api'
          ? 'Run: node server/index.mjs\nAPI: http://127.0.0.1:4318/api/health\nNo dependencies need installing. Set WORKSPACE_DATA_FILE to an absolute persistent path.\n'
          : 'Deploy static/ with a static host; edit static/config.json to select the API origin.\nFor local evaluation: WORKSPACE_CONSOLE_DIRECTORY=static node serve-console.mjs\nConsole: http://127.0.0.1:4173\nStart the API separately. No dependencies need installing.\n';
      await writeFile(
        resolve(staged, 'README.txt'),
        `TiDB Workspace ${kind}\nSource: ${sourceSha}\nNode ${nodeVersion} for the local runner.\n${instructions}This loopback guest prototype is for trusted local evaluation, not public hosting.\nLocal data and provider credentials are never packaged.\n`,
      );
      const archive = resolve(destination, `workspace-${kind}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '-C', temporary, kind]);
      const digest = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
      artifacts.push({ archive, digest, info });
    }
    await writeFile(
      resolve(destination, 'SHA256SUMS'),
      artifacts
        .map(({ digest, info }) => `${digest}  workspace-${info.component}.tar.gz\n`)
        .join(''),
    );
    await writeFile(
      resolve(destination, 'build-info.json'),
      JSON.stringify(
        artifacts.map((item) => item.info),
        null,
        2,
      ) + '\n',
    );
    return artifacts;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const artifacts = await packageRuntime({
      root,
      destination: resolve(root, 'release'),
      sourceSha: process.argv[2],
    });
    for (const artifact of artifacts)
      console.log(`${artifact.info.component}: ${artifact.archive}; SHA-256: ${artifact.digest}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
