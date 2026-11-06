import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = new URL('../console/public/skills/tidb-agent-workspace/', import.meta.url);
const hashes = {};
for (const name of [
  'SKILL.md',
  'private-csv.md',
  'workspace-api.md',
  'report.py',
  'private_csv.py',
]) {
  hashes[name] = createHash('sha256')
    .update(await readFile(new URL(name, base)))
    .digest('hex');
}
const target = new URL('install.py', base);
const source = await readFile(target, 'utf8');
if (!/^ASSETS = (.+)$/m.test(source)) throw Error('Installer asset manifest missing.');
const next = source.replace(/^ASSETS = .*$/m, 'ASSETS = ' + JSON.stringify(hashes));
if (process.argv.includes('--write')) await writeFile(target, next);
else if (source !== next)
  throw Error('Update installer integrity hashes: node scripts/check-trial-installer.mjs --write');

// Keep old public URLs readable without redirects; older installers reject redirects.
const legacy = new URL('../console/public/skills/drive9-workspace/', import.meta.url);
for (const name of [...Object.keys(hashes), 'install.py']) {
  const content = name === 'install.py' ? next : await readFile(new URL(name, base), 'utf8');
  if (process.argv.includes('--write')) {
    await mkdir(legacy, { recursive: true });
    await writeFile(new URL(name, legacy), content);
  } else if ((await readFile(new URL(name, legacy), 'utf8')) !== content) {
    throw Error('Update legacy skill aliases: node scripts/check-trial-installer.mjs --write');
  }
}
