import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { readSkillPlacements } from './skill-placements.ts';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));

let root: string;
let server: BootedServer;
beforeAll(async () => {
  isolated.home = mkdtempSync(join(tmpdir(), 'ok-reform-home-'));
  root = mkdtempSync(join(tmpdir(), 'ok-reform-project-'));
  mkdirSync(join(root, '.claude'));
  server = await bootCompositionRig(root, { configHomedirOverride: isolated.home });
  await server.ready;
}, 60_000);
afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
  rmSync(isolated.home, { recursive: true, force: true });
});

async function request(method: 'POST' | 'PUT', path: string, body: object) {
  return rawRequest(server.port, path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'custom-root-reform' },
    body: JSON.stringify(body),
  });
}

async function setUp(name: string, customRoot: string): Promise<string> {
  const source = join(root, '.claude/skills', name);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nBody.\n`);
  const declared = await request('PUT', '/api/skill-targets', {
    folderAction: { action: 'add-root', scope: 'project', root: customRoot },
  });
  expect(declared.status, declared.body).toBe(200);
  return source;
}

async function addAs(name: string, customRoot: string, mode: 'link' | 'copy') {
  const res = await request('POST', '/api/skill/install', {
    scope: 'project',
    name,
    add: [customRoot],
    mode,
  });
  expect(res.status, res.body).toBe(200);
}

function placement(name: string, path: string) {
  return readSkillPlacements(root)[name]?.find((p) => p.path === path);
}

test('re-adding a custom-root copy as a link records the link', async () => {
  const name = 'reform-to-link';
  await setUp(name, '.ra/skills');
  await addAs(name, '.ra/skills', 'copy');
  expect(placement(name, `.ra/skills/${name}`)).toMatchObject({ mode: 'copy' });

  await addAs(name, '.ra/skills', 'link');
  expect(lstatSync(join(root, '.ra/skills', name)).isSymbolicLink()).toBe(true);
  expect(placement(name, `.ra/skills/${name}`)).toMatchObject({ mode: 'link' });
}, 60_000);

test('re-adding a custom-root link as a copy records the copy and its hash', async () => {
  const name = 'reform-to-copy';
  const source = await setUp(name, '.rb/skills');
  await addAs(name, '.rb/skills', 'link');
  expect(placement(name, `.rb/skills/${name}`)).toMatchObject({ mode: 'link' });

  await addAs(name, '.rb/skills', 'copy');
  expect(lstatSync(join(root, '.rb/skills', name)).isSymbolicLink()).toBe(false);
  expect(placement(name, `.rb/skills/${name}`)).toMatchObject({
    mode: 'copy',
    hash: parseSkillDir(source)?.contentHash,
  });
}, 60_000);
