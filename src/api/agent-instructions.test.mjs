import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { agentInstructions, workspaceSkillTask, workspaceSkillUrl } from './agent-instructions.ts';

test('downloaded agent instructions reference current OpenAPI operations and mounted origins', async () => {
  const contract = JSON.parse(
    await readFile(new URL('../../public/openapi.json', import.meta.url), 'utf8'),
  );
  const global = JSON.parse(
    await readFile(new URL('../../public/agent-entry-openapi.json', import.meta.url), 'utf8'),
  );
  const text = agentInstructions('https://workspace.example/studio/api');
  assert.ok(text.includes('API endpoint: https://workspace.example/studio/api'));
  assert.ok(global.paths['/v1/token-issuances']?.post);
  assert.ok(global.paths['/v1/workspaces/{workspaceId}/region-route']?.get);
  for (const [, method, path] of text.matchAll(
    /\b(GET|POST|PUT|DELETE) (\/[a-zA-Z0-9/{}?=&*-]+)/g,
  )) {
    if (path.startsWith('/v1/')) {
      assert.ok(global.paths[path]?.[method.toLowerCase()], `${method} ${path}`);
    } else {
      const canonical = '/workspaces/{workspaceId}' + path.split('?')[0];
      assert.ok(contract.paths[canonical]?.[method.toLowerCase()], `${method} ${canonical}`);
    }
  }
  assert.equal(
    /\/database-imports\/prepare|\/file-exports\/prepare|\/table\?name=|\/table\/rows/.test(text),
    false,
  );
  assert.match(text, /Idempotency-Key/);
  assert.match(text, /If-Match/);
});

test('task points to the portable skill without exposing credentials', () => {
  const task = 'Analyze /us-sales.csv and write /us-sales-report.md.';
  const skill = workspaceSkillUrl('https://workspace.example', '/studio/');
  const text = workspaceSkillTask('https://workspace.example/studio/api', skill, task);
  const linked = [...text.matchAll(/https?:\/\/\S+/g)].map(
    ([value]) => new URL(value.replace(/[.,;:]+$/, '')),
  );
  const endpoint = new URL('https://workspace.example/studio/api');
  assert.ok(
    linked.some((url) => url.origin === endpoint.origin && url.pathname === endpoint.pathname),
  );
  const expectedSkill = new URL(skill);
  assert.ok(
    linked.some(
      (url) => url.origin === expectedSkill.origin && url.pathname === expectedSkill.pathname,
    ),
  );
  assert.ok(text.includes(task));
  assert.match(text, /unauthenticated GET/);
  assert.match(text, /If the skill is unavailable, stop/);
  assert.doesNotMatch(text, /POST \/file-analyses/);
  assert.equal(workspaceSkillUrl('https://workspace.example', '/studio'), skill);
  assert.equal(workspaceSkillUrl('https://workspace.example', '/studio/index.html'), skill);
});

test('published Workspace skill is portable and preserves credential and write safeguards', async () => {
  const skill = await readFile(
    new URL('../../console/public/skills/tidb-agent-workspace/SKILL.md', import.meta.url),
    'utf8',
  );
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(match, 'skill has YAML frontmatter');
  const metadata = parse(match[1]);
  assert.equal(metadata.name, 'tidb-agent-workspace');
  assert.ok(typeof metadata.description === 'string' && metadata.description.length > 0);
  assert.ok(metadata.description.length <= 1024);
  assert.match(skill, /\[the authenticated API\]\(workspace-api.md\)/);
  const api = await readFile(
    new URL('../../console/public/skills/tidb-agent-workspace/workspace-api.md', import.meta.url),
    'utf8',
  );
  assert.match(api, /Do not follow the\s+307 redirect/);
  assert.match(api, /Verify the response's region origin, path, and ID/);
  assert.match(api, /If-None-Match: \*/);
  assert.match(api, /If-Match/);
  assert.match(api, /rather than blindly retrying/);
  assert.doesNotMatch(skill + api, /awk_[A-Za-z0-9]+/);
});
