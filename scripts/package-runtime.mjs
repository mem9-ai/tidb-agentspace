import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageRuntime({ root, destination, sourceSha, binary }) {
  const api = JSON.parse(
    execFileSync(
      'cargo',
      [
        'run',
        '--quiet',
        '--locked',
        '-p',
        'workspace-build-tools',
        '--',
        'package',
        sourceSha,
        binary || resolve(root, 'meta-service/target/debug/workspace-backend'),
        destination,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  const temporary = await mkdtemp(resolve(tmpdir(), 'workspace-console-package-'));
  try {
    const staged = resolve(temporary, 'console');
    await mkdir(staged);
    await cp(resolve(root, 'LICENSE'), resolve(staged, 'LICENSE'));
    await cp(resolve(root, 'dist/console'), resolve(staged, 'static'), { recursive: true });
    await cp(resolve(root, 'scripts/serve-console.mjs'), resolve(staged, 'serve-console.mjs'));
    const info = {
      sourceSha,
      component: 'console',
      audience: 'internal-local-demo',
      deployed: false,
    };
    await writeFile(resolve(staged, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    await writeFile(
      resolve(staged, 'README.txt'),
      'Serve static/ independently of the Rust API. Set static/config.json apiOrigin. The optional local Node runner is not a business backend.\n',
    );
    const archive = resolve(destination, 'workspace-console.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', temporary, 'console']);
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await writeFile(
      resolve(destination, 'SHA256SUMS'),
      `${api.sha256}  ${basename(api.archive)}\n${sha256}  ${basename(archive)}\n`,
    );
    await writeFile(
      resolve(destination, 'build-info.json'),
      JSON.stringify(
        [{ sourceSha, component: 'rust-api', binarySha256: api.binarySha256 }, info],
        null,
        2,
      ) + '\n',
    );
    return [api, { archive, sha256, ...info }];
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  console.log(
    JSON.stringify(
      await packageRuntime({
        root,
        destination: resolve(root, 'release'),
        sourceSha: process.argv[2],
        binary: process.argv[3],
      }),
    ),
  );
}
