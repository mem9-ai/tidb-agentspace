import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
// Packaging is build tooling; the resulting API executable never starts Node.
export async function packageRustApi({ root, sourceSha, binary, destination }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || /^0+$/.test(sourceSha))
    throw new Error('A full reviewed source SHA is required.');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (head !== sourceSha) throw new Error('Package the checked-out reviewed revision.');
  execFileSync('git', ['diff', '--exit-code', 'HEAD'], { cwd: root, stdio: 'ignore' });
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
    throw new Error('Package only clean reviewed source, including newly added files.');
  const executable = await lstat(binary);
  if (!executable.isFile() || executable.isSymbolicLink())
    throw new Error('Package an ordinary native executable, not a symbolic link.');
  const runtime = JSON.parse(
    execFileSync(binary, ['runtime-info'], { encoding: 'utf8', timeout: 15000 }),
  ).duckdb;
  const pins = JSON.parse(await readFile(resolve(root, 'scripts/duckdb-runtime.json'), 'utf8'));
  if (
    runtime?.version !== pins.version ||
    runtime.linkage !== 'static' ||
    pins.artifacts[runtime.target]?.platform !== process.platform ||
    pins.artifacts[runtime.target]?.arch !== process.arch ||
    runtime.archiveSha256 !== pins.artifacts[runtime.target]?.sha256
  )
    throw new Error('Native artifact does not match the pinned static DuckDB runtime.');
  const temporary = await mkdtemp(resolve(tmpdir(), 'workspace-rust-package-'));
  try {
    const staged = resolve(temporary, 'api');
    await mkdir(staged);
    await cp(binary, resolve(staged, 'workspace-backend'));
    await chmod(resolve(staged, 'workspace-backend'), 0o755);
    await cp(resolve(root, 'Cargo.lock'), resolve(staged, 'Cargo.lock'));
    await cp(resolve(root, 'public/openapi.json'), resolve(staged, 'openapi.json'));
    await cp(resolve(root, 'public/owner-openapi.json'), resolve(staged, 'owner-openapi.json'));
    await cp(resolve(root, 'public/global-openapi.json'), resolve(staged, 'global-openapi.json'));
    await cp(
      resolve(root, 'public/agent-entry-openapi.json'),
      resolve(staged, 'agent-entry-openapi.json'),
    );
    const info = {
      sourceSha,
      component: 'rust-api',
      platform: process.platform,
      architecture: process.arch,
      rust: (await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8')).match(
        /channel\s*=\s*"([^"]+)"/,
      )?.[1],
      binarySha256: await digest(resolve(staged, 'workspace-backend')),
      duckdb: runtime,
      audience: 'internal-local-demo',
      deployed: false,
    };
    await writeFile(resolve(staged, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    await writeFile(
      resolve(staged, 'README.txt'),
      `Rust Workspace API\nSource: ${sourceSha}\nRun: ./workspace-backend serve --config /absolute/private/deployment.json\nThe same executable hosts Global/Region API and Meta roles; Region-internal Execute tasks exec this binary without a separate service or queue.\nRegional, Global and single-entry OpenAPI contracts are included.\nNo Node runtime or Console assets are required.\nUse docs/rust-backend.md for private configuration, migration, health and rollback.\nNative tidbfs requires a separately verified DuckDB 2.0 extension and its SHA-256.\nNo local state, secrets or provider credentials are included.\nPublic Owner login requires native SSO; Token-only Region hosting uses the explicit local security profile. Trusted origins and private S3 plans are required; see docs/native-studio-deployment.md. Customer isolation and production compute hardening remain separate work.\n`,
    );
    await mkdir(destination, { recursive: true });
    const archive = resolve(
      destination,
      `workspace-rust-api-${process.platform}-${process.arch}.tar.gz`,
    );
    execFileSync('tar', ['-czf', archive, '-C', temporary, 'api']);
    const sha256 = await digest(archive);
    await writeFile(resolve(destination, 'SHA256SUMS'), `${sha256}  ${basename(archive)}\n`);
    await writeFile(resolve(destination, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    return { archive, sha256, ...info };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  console.log(
    JSON.stringify(
      await packageRustApi({
        root,
        sourceSha: process.argv[2],
        binary: resolve(process.argv[3] || 'meta-service/target/debug/workspace-backend'),
        destination: resolve(process.argv[4] || 'release/rust-api'),
      }),
    ),
  );
}
