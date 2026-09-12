import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HistorySuccessSchema,
  SkillReimportSuccessSchema,
  SkillRestoreSuccessSchema,
  SkillRevertSuccessSchema,
  SkillsReimportBulkSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { ensureProjectGit } from './project-git.ts';
import { readSkillsLockFile as readSkillsLock } from './skills-lock-store.ts';

let root: string;
let source: string;
let server: BootedServer;
const markdown = (name: string, revision: string) =>
  `---\nname: ${name}\ndescription: Recovery contract\n---\n\n${revision}: \\* and <custom>raw</custom>.  \n\n`;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-recovery-contract-')));
  source = mkdtempSync(join(tmpdir(), 'ok-recovery-source-'));
  mkdirSync(join(root, '.claude'));
  await ensureProjectGit(root);
  server = await bootCompositionRig(root, { gitEnabled: true });
  await server.ready;
}, 60_000);
afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});
async function post(path: string, body: object) {
  return rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'recovery-contract' },
    body: JSON.stringify(body),
  });
}
function seed(name: string, revision: string) {
  const dir = join(source, name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown(name, revision));
  writeFileSync(join(dir, 'assets/data.bin'), Buffer.from([0, 255, revision.length]));
  return dir;
}
async function importSkill(name: string) {
  const result = await post('/api/skill/import', {
    source: seed(name, 'old'),
    install: false,
    agentId: 'recovery-importer',
  });
  expect(result.status, result.body).toBe(200);
}

test('reimport preserves upstream bytes, removed files, dry runs and actor provenance', async () => {
  const name = 'recover-single';
  await importSkill(name);
  const installed = join(root, '.claude/skills', name);
  const before = readFileSync(join(installed, 'SKILL.md'), 'utf8');
  seed(name, 'new revision');
  rmSync(join(source, name, 'assets/data.bin'));
  const dry = await post('/api/skill/reimport', { name, scope: 'project', dryRun: true });
  expect(dry.status, dry.body).toBe(200);
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(before);
  expect(existsSync(join(installed, 'assets/data.bin'))).toBe(true);
  const result = await post('/api/skill/reimport', {
    name,
    scope: 'project',
    agentId: 'recovery-writer',
  });
  expect(result.status, result.body).toBe(200);
  expect(SkillReimportSuccessSchema.parse(JSON.parse(result.body))).toMatchObject({
    name,
    updated: true,
    source: join(source, name),
  });
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(markdown(name, 'new revision'));
  expect(existsSync(join(installed, 'assets/data.bin'))).toBe(false);
  const history = await rawRequest(
    server.port,
    `/api/history?docName=${encodeURIComponent(`.claude/skills/${name}/SKILL`)}`,
  );
  expect(history.status, history.body).toBe(200);
  expect(
    HistorySuccessSchema.parse(JSON.parse(history.body)).entries.flatMap(
      (entry) => entry.contributors,
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'agent-recovery-writer',
        docs: expect.arrayContaining([`.claude/skills/${name}/SKILL`]),
      }),
    ]),
  );
  expect(result.headers['x-request-id']).toBe('recovery-contract');
  const setting = await post('/api/skill/reimport', {
    name,
    scope: 'project',
    setAutoUpdate: false,
  });
  expect(setting.status, setting.body).toBe(200);
  expect(SkillReimportSuccessSchema.parse(JSON.parse(setting.body))).toMatchObject({
    name,
    updated: false,
  });
  expect(readSkillsLock(join(root, '.ok/skills-lock.json')).skills[name]?.autoUpdate).toBe(false);
});

test('restore and revert use the imported historical tree and preserve subsequent local tracking', async () => {
  const name = 'recover-history';
  await importSkill(name);
  const baseline = readSkillsLock(join(root, '.ok/skills-lock.json')).skills[name]?.baselineRef;
  expect(baseline).toMatch(/^[a-f0-9]{40}$/);
  const installed = join(root, '.claude/skills', name);
  const original = readFileSync(join(installed, 'SKILL.md'), 'utf8');
  writeFileSync(join(installed, 'SKILL.md'), markdown(name, 'local change'));
  writeFileSync(join(installed, 'extra.txt'), 'local addition');
  const restored = await post('/api/skill/restore', {
    name,
    version: baseline,
    agentId: 'restore-writer',
  });
  expect(restored.status, restored.body).toBe(200);
  expect(SkillRestoreSuccessSchema.parse(JSON.parse(restored.body))).toMatchObject({
    name,
    version: baseline,
    restoredFiles: ['SKILL.md', 'assets/data.bin'],
    warnings: [],
  });
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(original);
  expect(existsSync(join(installed, 'extra.txt'))).toBe(false);
  writeFileSync(join(installed, 'SKILL.md'), markdown(name, 'another change'));
  const reverted = await post('/api/skill/revert', { name, agentId: 'revert-writer' });
  expect(reverted.status, reverted.body).toBe(200);
  expect(SkillRevertSuccessSchema.parse(JSON.parse(reverted.body))).toMatchObject({
    name,
    baselineRef: baseline,
    restoredFiles: ['SKILL.md', 'assets/data.bin'],
    warnings: [],
  });
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(original);
  expect(readSkillsLock(join(root, '.ok/skills-lock.json')).skills[name]).toMatchObject({
    baselineRef: baseline,
    localHash: expect.any(String),
  });
  expect(reverted.headers['x-request-id']).toBe('recovery-contract');
});

test('bulk recovery deduplicates and preserves invalid, unrecorded and grouped partial result order', async () => {
  for (const name of ['recover-first', 'recover-second', 'recover-missing-source'])
    await importSkill(name);
  seed('recover-second', 'upstream changed');
  rmSync(join(source, 'recover-missing-source'), { recursive: true });
  const response = await post('/api/skills/reimport-bulk', {
    scope: 'project',
    names: [
      'recover-second',
      'not-imported',
      'INVALID NAME',
      'recover-first',
      'recover-second',
      'recover-missing-source',
    ],
    agentId: 'bulk-recovery-writer',
  });
  expect(response.status, response.body).toBe(200);
  const result = SkillsReimportBulkSuccessSchema.parse(JSON.parse(response.body));
  expect(result).toMatchObject({
    updated: 1,
    upToDate: 1,
    failed: 3,
    results: [
      { requested: 'INVALID NAME', status: 'failed', error: 'INVALID_NAME' },
      { requested: 'not-imported', status: 'not-found' },
      { requested: 'recover-second', status: 'updated' },
      { requested: 'recover-first', status: 'up-to-date' },
      { requested: 'recover-missing-source', status: 'failed' },
    ],
  });
  expect(readFileSync(join(root, '.claude/skills/recover-second/SKILL.md'), 'utf8')).toBe(
    markdown('recover-second', 'upstream changed'),
  );
  expect(readFileSync(join(root, '.claude/skills/recover-missing-source/SKILL.md'), 'utf8')).toBe(
    markdown('recover-missing-source', 'old'),
  );
  expect(response.headers['x-request-id']).toBe('recovery-contract');
});

test('recovery refusal envelopes preserve scope, absent source and missing baseline distinctions', async () => {
  for (const [path, body, status, detail] of [
    [
      '/api/skill/restore',
      { name: 'recover-history', scope: 'global', version: 'f'.repeat(40) },
      400,
      'GLOBAL_SCOPE_UNVERSIONED',
    ],
    [
      '/api/skill/restore',
      { name: 'recover-history', version: 'f'.repeat(40) },
      404,
      'version-not-found',
    ],
    ['/api/skill/revert', { name: 'recover-history', scope: 'global' }, 400, 'GLOBAL_SCOPE'],
    ['/api/skill/revert', { name: 'not-imported' }, 400, 'NO_BASELINE'],
    ['/api/skill/reimport', { name: 'not-imported' }, 404, 'SKILL_ABSENT'],
  ] as const) {
    const response = await post(path, body);
    expect(response.status, response.body).toBe(status);
    expect(JSON.parse(response.body).detail).toBe(detail);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['x-request-id']).toBe('recovery-contract');
  }
});
