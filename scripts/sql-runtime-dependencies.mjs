import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

// Copy the installed, pinned runtime closure, including ESM-only and native-binding packages.
export async function copySqlDependencies(root, staged) {
  root = await realpath(root);
  const copied = new Set();
  async function copy(name, from, optional = false) {
    let directory, pkg;
    for (const search of createRequire(resolve(from, 'package.json')).resolve.paths(
      `${name}/package.json`,
    ) || []) {
      const candidate = resolve(search, name);
      try {
        const metadata = JSON.parse(await readFile(resolve(candidate, 'package.json'), 'utf8'));
        if (metadata.name === name) {
          directory = await realpath(candidate);
          pkg = metadata;
          break;
        }
      } catch {
        /* Try the next Node package search directory. */
      }
    }
    if (!directory) {
      if (optional) return;
      throw new Error(`Cannot locate runtime dependency ${name}.`);
    }
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
  await copy('@duckdb/node-api', root);
  await copy('just-bash', root);
}
