import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function verifyDuckdb(directory, artifact) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    for (const [name, expected] of Object.entries(artifact.files)) {
      const path = resolve(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(path)) !== expected)
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function prepareDuckdb({
  root = repository,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
} = {}) {
  const pins = JSON.parse(await readFile(resolve(root, 'scripts/duckdb-runtime.json'), 'utf8'));
  const selected = Object.entries(pins.artifacts).find(
    ([, artifact]) => artifact.platform === platform && artifact.arch === arch,
  );
  if (!selected) throw new Error(`No verified DuckDB static artifact for ${platform}/${arch}.`);
  const [target, artifact] = selected;
  if (
    !/^\d+\.\d+\.\d+$/.test(pins.version) ||
    !/^duckdb-static-libs-[a-z0-9-]+\.tar\.gz$/.test(artifact.asset) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > 128 * 1024 * 1024 ||
    !Object.entries(artifact.files).every(
      ([name, hash]) => /^[a-z0-9_]+\.(a|h)$/.test(name) && /^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error('Invalid pinned DuckDB artifact definition.');
  const directory = resolve(root, '.data/duckdb-native', pins.version);
  const result = { version: pins.version, target, archiveSha256: artifact.sha256, directory };
  if (await verifyDuckdb(directory, artifact)) return { ...result, cached: true };
  try {
    await lstat(directory);
    throw new Error(
      'DuckDB build cache is corrupt or belongs to another target; remove only that cache and prepare again.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(directory), { recursive: true });
  const temporary = await mkdtemp(directory + '.download-');
  try {
    const url = `https://github.com/duckdb/duckdb/releases/download/v${pins.version}/${artifact.asset}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`DuckDB artifact download failed: HTTP ${response.status}.`);
    if (!response.body) throw new Error('DuckDB archive has no body.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > artifact.size) throw new Error('DuckDB archive exceeds its pinned size.');
      chunks.push(chunk);
    }
    if (size !== artifact.size) throw new Error('DuckDB archive size mismatch.');
    const bytes = Buffer.concat(chunks, size);
    if (digest(bytes) !== artifact.sha256) throw new Error('DuckDB archive checksum mismatch.');
    const archive = resolve(temporary, 'download.tar.gz');
    await writeFile(archive, bytes);
    const files = Object.keys(artifact.files);
    execFileSync('tar', ['-xzf', archive, '-C', temporary, '--', ...files]);
    await rm(archive);
    if (!(await verifyDuckdb(temporary, artifact)))
      throw new Error('DuckDB extracted library checksum or file type mismatch.');
    await writeFile(
      resolve(temporary, 'build-info.json'),
      JSON.stringify({ ...result, directory: undefined, asset: artifact.asset }, null, 2) + '\n',
    );
    try {
      await rename(temporary, directory);
    } catch (error) {
      // A concurrent identical preparation may win; never replace an unverified cache.
      if (
        !['EEXIST', 'ENOTEMPTY'].includes(error.code) ||
        !(await verifyDuckdb(directory, artifact))
      )
        throw error;
    }
    return { ...result, cached: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await prepareDuckdb()));
