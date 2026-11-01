import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globalApiProfile } from './global-api-profile.mjs';

async function privateJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error('Private regular configuration files required.');
  return JSON.parse(await readFile(path, 'utf8'));
}
// Prepare a new private plan; never overwrite the active deployment or initialize Meta storage.
export async function prepareGlobalCutover({
  sourcePlan,
  directory,
  mountDirectory,
  clockDirectory,
}) {
  if (![sourcePlan, directory, mountDirectory, clockDirectory].every(isAbsolute))
    throw new Error('Use absolute configuration and persistent clock paths.');
  const plan = await privateJson(sourcePlan);
  if (
    plan.format !== 1 ||
    plan.services.some((s) => s.kind === 'global') ||
    plan.services.filter((s) => s.kind === 'workspace').length !== 1
  )
    throw new Error('Expected one existing Region and no existing Global API.');
  const region = plan.services.find((s) => s.kind === 'workspace');
  const api = await privateJson(region.configFile);
  if (api.security || api.globalEntry)
    throw new Error(
      'Global security already configured; do not replace active signing identities.',
    );
  const metadata = await Promise.all(
    plan.services.filter((s) => s.kind === 'metadata').map((s) => privateJson(s.configFile)),
  );
  if (!metadata.some((c) => c.authorityId === 'global'))
    throw new Error('The existing plan must contain its Global Meta authority.');
  await mkdir(directory, { mode: 0o700 });
  const profile = await globalApiProfile({
    directory: resolve(directory, 'security'),
    mountDirectory: resolve(mountDirectory, 'security'),
    api,
    clockDirectory,
    initializeClock: true,
  });
  const save = (name, value) =>
    writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  await save('api.json', profile.api);
  await save('global-api.json', profile.global);
  await save('deployment.json', {
    ...plan,
    services: [
      ...plan.services.map((s) =>
        s === region ? { ...s, configFile: resolve(mountDirectory, 'api.json') } : s,
      ),
      { kind: 'global', configFile: resolve(mountDirectory, 'global-api.json') },
    ],
  });
  return {
    plan: resolve(directory, 'deployment.json'),
    globalBase: profile.global.publicOrigin + profile.global.publicPath,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareGlobalCutover({
      sourcePlan: process.argv[2],
      directory: process.argv[3],
      mountDirectory: process.argv[4],
      clockDirectory: process.argv[5],
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      'Global API cutover preparation failed. Check private paths, existing roles and signing identity; no active configuration was overwritten.',
    );
    process.exitCode = 1;
  }
}
