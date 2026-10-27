import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const expectedNode = readFileSync(new URL('.node-version', root), 'utf8').trim();
const { packageManager } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const expectedNpm = packageManager.replace('npm@', '');
const agent = process.env.npm_config_user_agent || '';
const currentNpm = /^npm\/([^ ]+)/.exec(agent)?.[1];

if (process.versions.node !== expectedNode || (currentNpm && currentNpm !== expectedNpm)) {
  console.error(`Use Node ${expectedNode} and npm ${expectedNpm}. See CONTRIBUTING.md for setup.`);
  console.error(
    `Detected Node ${process.versions.node}${currentNpm ? ` and npm ${currentNpm}` : ''}.`,
  );
  process.exitCode = 1;
} else {
  console.log(`Runtime verified: Node ${expectedNode}${currentNpm ? `, npm ${currentNpm}` : ''}.`);
}
