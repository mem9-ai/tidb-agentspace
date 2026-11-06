import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const base = new URL('../console/public/skills/drive9-workspace/', import.meta.url);
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
