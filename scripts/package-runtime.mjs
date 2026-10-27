import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, relative } from 'node:path';

export async function copySqlDependencies(root, staged) {
  root = await realpath(root);
  const copied = new Set();
  async function copy(name, from, optional = false) {
    let entry;
    try {
      entry = createRequire(resolve(from, 'package.json')).resolve(name);
    } catch (error) {
      if (optional && error.code === 'MODULE_NOT_FOUND') return;
      throw error;
    }
    let directory = dirname(entry),
      pkg;
    while (directory !== dirname(directory)) {
      try {
        pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        if (pkg.name === name) break;
      } catch {
        /* An entry point may be inside a package subdirectory. */
      }
      directory = dirname(directory);
    }
    if (pkg?.name !== name) throw new Error(`Cannot locate runtime dependency ${name}.`);
    const path = relative(root, directory);
    if (!path.startsWith('node_modules/'))
      throw new Error('Runtime dependency is outside the installed lockfile tree.');
    if (copied.has(path)) return;
    copied.add(path);
    await mkdir(dirname(resolve(staged, path)), { recursive: true });
    await cp(directory, resolve(staged, path), { recursive: true });
    for (const dependency of Object.keys(pkg.dependencies || {})) await copy(dependency, directory);
    for (const dependency of Object.keys(pkg.optionalDependencies || {}))
      await copy(dependency, directory, true);
  }
  await copy('mysql2', root);
}

export async function packageRuntime({ root, destination, sourceSha }) {
  if (!/^[a-f0-9]{40}$/i.test(sourceSha || '') || /^0+$/.test(sourceSha))
    throw new Error('A full source commit SHA is required.');
  const temporary = await mkdtemp(resolve(tmpdir(), 'tidb-runtime-'));
  try {
    const staged = resolve(temporary, 'workspace');
    await mkdir(staged);
    for (const path of [
      'dist',
      'server/index.mjs',
      'server/store.mjs',
      'server/access-policy.mjs',
      'server/file-transfer.mjs',
      'server/providers/drive9.mjs',
      'server/providers/sql-common.mjs',
      'server/providers/zero.mjs',
      'server/providers/sql-drivers.mjs',
      'public/openapi.json',
    ]) {
      const target = resolve(staged, path);
      await mkdir(resolve(target, '..'), { recursive: true });
      await cp(resolve(root, path), target, { recursive: true });
    }
    await copySqlDependencies(root, staged);
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const nodeVersion = (await readFile(resolve(root, '.node-version'), 'utf8')).trim();
    const info = {
      sourceSha,
      version: pkg.version,
      nodeVersion,
      audience: 'internal-local-demo',
      deployed: false,
    };
    await writeFile(resolve(staged, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    await writeFile(
      resolve(staged, 'README.txt'),
      `TiDB Workspace internal demo\nSource: ${sourceSha}\nUse Node ${nodeVersion}. Run: node server/index.mjs\nOpen http://127.0.0.1:4318. No dependencies need installing.\nThis guest runtime is for trusted local evaluation; it is not a public deployment.\nLocal data is created under .data/ at runtime and is not packaged.\n`,
    );
    await mkdir(destination, { recursive: true });
    const archive = resolve(destination, 'workspace-runtime.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', temporary, 'workspace']);
    const digest = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await writeFile(resolve(destination, 'SHA256SUMS'), `${digest}  workspace-runtime.tar.gz\n`);
    await writeFile(resolve(destination, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    return { archive, digest, info };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const result = await packageRuntime({
      root,
      destination: resolve(root, 'release'),
      sourceSha: process.argv[2],
    });
    console.log(
      `Internal artifact created for ${result.info.sourceSha}; SHA-256: ${result.digest}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
