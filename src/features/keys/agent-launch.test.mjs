import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentLaunchCommand } from './agent-launch.ts';

for (const shell of ['/bin/bash', '/bin/zsh']) {
  for (const agent of ['pi', 'codex', 'claude']) {
    test(`${agent} launch passes the task safely and confines the key in ${shell}`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'agent-launch-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const path = join(directory, agent);
      await writeFile(
        path,
        '#!/bin/sh\nprintf "%s" "$1" > "$TEST_PROMPT"\nprintf "%s" "$WORKSPACE_API_KEY" > "$TEST_KEY"\n',
      );
      await chmod(path, 0o700);
      const prompt = `Investigate a user's sales; $(touch ${directory}/injected) 'quoted'`;
      const secret = 'synthetic-launch-key';
      const command = agentLaunchCommand(agent, prompt);
      assert.ok(!command.includes(secret));
      assert.ok(!command.includes('\n'));
      const env = {
        ...process.env,
        PATH: `${directory}:/usr/bin:/bin`,
        TEST_PROMPT: join(directory, 'prompt'),
        TEST_KEY: join(directory, 'key'),
      };
      delete env.WORKSPACE_API_KEY;
      const child = spawn(shell, ['-c', `${command}; test -z "${'${WORKSPACE_API_KEY+x}'}"`], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.stdin.end(`${secret}\n`);
      const exit = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(exit, 0, output);
      assert.equal(await readFile(join(directory, 'prompt'), 'utf8'), prompt);
      assert.equal(await readFile(join(directory, 'key'), 'utf8'), secret);
      assert.ok(!output.includes(secret));
      await assert.rejects(readFile(join(directory, 'injected')));
    });
  }
}

test('a missing agent fails before asking for a Key', async () => {
  const command = agentLaunchCommand('pi', 'Run a task');
  const child = spawn('/bin/bash', ['-c', command], {
    env: { ...process.env, PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.stdin.end();
  const exit = await new Promise((resolve) => child.on('close', resolve));
  assert.notEqual(exit, 0);
  assert.match(output, /Install pi/);
  assert.doesNotMatch(output, /Paste your Workspace Key/);
});
