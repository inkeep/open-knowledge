import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { readSkillsLockFile } from './skills-lock-store.ts';

const scenario = vi.hoisted(() => ({ mode: 'real' as 'real' | 'bulk-files' | 'generic' }));
vi.mock('@inkeep/open-knowledge-core/skills-catalog', async (original) => {
  const actual = await original<typeof import('@inkeep/open-knowledge-core/skills-catalog')>();
  return {
    ...actual,
    readWellKnownIndex: (...args: Parameters<typeof actual.readWellKnownIndex>) =>
      scenario.mode === 'bulk-files'
        ? Promise.resolve({
            basePath: '/.well-known/agent-skills',
            skills: [{ name: 'fixture', description: '', files: ['SKILL.md'] }],
          })
        : actual.readWellKnownIndex(...args),
    fetchSource: (...args: Parameters<typeof actual.fetchSource>) => {
      if (scenario.mode === 'bulk-files' && args[0].kind === 'well-known')
        return Promise.reject(new actual.SkillDestinationPolicyError(args[0].origin));
      return actual.fetchSource(...args);
    },
    discoverWellKnownSkills: (...args: Parameters<typeof actual.discoverWellKnownSkills>) =>
      scenario.mode === 'generic'
        ? Promise.reject(new actual.SkillFetchError('internal-cause-not-public'))
        : actual.discoverWellKnownSkills(...args),
  };
});

let root: string;
let server: BootedServer;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'skill-policy-http-'));
  mkdirSync(join(root, '.claude'));
  server = await bootCompositionRig(root);
  await server.ready;
}, 60_000);
beforeEach(() => {
  scenario.mode = 'real';
});
afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

function post(path: string, body: object) {
  return rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test.each([
  ['discover', '/api/skills/discover?source=127.0.0.1', null],
  ['preview', '/api/skills/preview?source=127.0.0.1&name=fixture', null],
  ['single import', '/api/skill/import', { source: '127.0.0.1', skill: 'fixture', install: false }],
  [
    'bulk index',
    '/api/skills/import-bulk',
    { source: '127.0.0.1', skills: ['fixture'], install: false },
  ],
] as const)(
  'publishes a single actionable private-origin remedy for %s',
  async (_name, path, body) => {
    const response = body === null ? await rawRequest(server.port, path) : await post(path, body);
    expect(response.status, response.body).toBe(400);
    const problem = JSON.parse(response.body);
    expect(problem.title).toBe('Website source requires explicit trust.');
    expect(problem.detail.split('https://127.0.0.1')).toHaveLength(2);
    expect(problem.detail.split('skills.trustedPrivateOrigins')).toHaveLength(2);
  },
);

test('bulk per-skill policy failures are failed with the remedy, not not-found', async () => {
  scenario.mode = 'bulk-files';
  const response = await post('/api/skills/import-bulk', {
    source: '127.0.0.1',
    skills: ['fixture'],
    install: false,
  });
  expect(response.status, response.body).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    failed: 1,
    results: [
      {
        requested: 'fixture',
        status: 'failed',
        error: expect.stringContaining('skills.trustedPrivateOrigins'),
      },
    ],
  });
});

test('ordinary fetch failures keep their internal cause out of public details', async () => {
  scenario.mode = 'generic';
  const response = await rawRequest(server.port, '/api/skills/discover?source=127.0.0.1');
  expect(response.status, response.body).toBe(400);
  expect(response.body).not.toContain('internal-cause-not-public');
  expect(JSON.parse(response.body).detail).toBeUndefined();
});

test('reimport of a formerly approved website source publishes the remedy', async () => {
  const name = 'policy-reimport';
  const source = join(root, 'source', name);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Synthetic fixture\n---\n\nFixture.\n`,
  );
  const imported = await post('/api/skill/import', { source, install: false });
  expect(imported.status, imported.body).toBe(200);
  const file = join(root, '.ok', 'skills-lock.json');
  const lock = readSkillsLockFile(file);
  const entry = lock.skills[name];
  if (!entry) throw new Error('Expected imported skill');
  writeFileSync(
    file,
    JSON.stringify({
      ...lock,
      skills: { ...lock.skills, [name]: { ...entry, source: '127.0.0.1', upstreamSkill: name } },
    }),
  );
  const response = await post('/api/skill/reimport', { name, scope: 'project' });
  expect(response.status, response.body).toBe(400);
  expect(JSON.parse(response.body)).toMatchObject({
    title: 'Website source requires explicit trust.',
    detail: expect.stringContaining('https://127.0.0.1'),
  });
});
