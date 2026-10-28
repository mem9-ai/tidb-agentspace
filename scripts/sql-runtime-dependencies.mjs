import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

export async function copySqlDependencies(root, staged) {
  root = await realpath(root);
  const copied = new Set();
  async function copy(name, from, optional = false) {
    let entry;
    try {
      entry = createRequire(resolve(from, 'package.json')).resolve(name);
    } catch (error) {
      // Platform bindings have no root JS entry; their package contains a native .node file.
      try {
        entry = createRequire(resolve(from, 'package.json')).resolve(name + '/package.json');
      } catch {
        if (optional && error.code === 'MODULE_NOT_FOUND') return;
        throw error;
      }
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
  await copy('@duckdb/node-api', root);
}
