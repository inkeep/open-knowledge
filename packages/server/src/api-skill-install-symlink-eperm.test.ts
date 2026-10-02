import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

vi.mock('./fs-traced.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-traced.ts')>();
  return {
    ...actual,
    tracedSymlinkSync: (): void => {
      throw Object.assign(new Error('EPERM: operation not permitted, symlink'), {
        code: 'EPERM',
        syscall: 'symlink',
      });
    },
  };
});

let root: string;
let server: BootedServer;
beforeAll(async () => {
  isolated.home = mkdtempSync(join(tmpdir(), 'ok-eperm-home-'));
  root = mkdtempSync(join(tmpdir(), 'ok-eperm-project-'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, '.cursor'));
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
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'symlink-eperm' },
    body: JSON.stringify(body),
  });
}

async function install(body: object) {
  return request('POST', '/api/skill/install', { scope: 'project', ...body });
}

function seed(name: string): string {
  const source = join(root, '.claude/skills', name);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nBody.\n`);
  return source;
}

function isRealDirWithSkill(path: string): boolean {
  return existsSync(join(path, 'SKILL.md')) && !lstatSync(path).isSymbolicLink();
}

function placement(name: string, path: string) {
  return readSkillPlacements(root)[name]?.find((p) => p.path === path);
}

function warningCodes(body: string): string[] {
  return (JSON.parse(body) as { warningCodes?: string[] }).warningCodes ?? [];
}

test('without symlink rights, add falls back to a copy and convert-to-link keeps it', async () => {
  const name = 'eperm-skill';
  const source = seed(name);
  const added = join(root, '.cursor/skills', name);
  const hash = parseSkillDir(source)?.contentHash;

  const add = await install({ name, add: ['cursor'] });
  expect(add.status, add.body).toBe(200);
  expect(warningCodes(add.body)).toContain('links-not-permitted');
  expect(isRealDirWithSkill(added)).toBe(true);
  expect(placement(name, `.cursor/skills/${name}`)).toMatchObject({ mode: 'copy', hash });

  const toCopy = await install({ name, convert: { target: 'cursor', mode: 'copy' } });
  expect(toCopy.status, toCopy.body).toBe(200);

  const toLink = await install({ name, convert: { target: 'cursor', mode: 'link' } });
  expect(toLink.status, toLink.body).toBe(403);
  expect(JSON.parse(toLink.body)).toMatchObject({
    type: 'urn:ok:error:links-not-permitted',
    title:
      'This system does not allow creating symlinks, so that location was left as a copy. On Windows, creating symlinks needs administrator rights or Developer Mode.',
  });
  expect(isRealDirWithSkill(added)).toBe(true);
  expect(placement(name, `.cursor/skills/${name}`)).toMatchObject({ mode: 'copy', hash });
}, 60_000);

test('an explicit link add reports that it made a copy', async () => {
  const name = 'eperm-explicit';
  seed(name);
  const add = await install({ name, add: ['cursor'], mode: 'link' });
  expect(add.status, add.body).toBe(200);
  expect(warningCodes(add.body)).toContain('links-not-permitted');
  expect(isRealDirWithSkill(join(root, '.cursor/skills', name))).toBe(true);
}, 60_000);

test('place with mode link records the copy it made, with its hash', async () => {
  const name = 'eperm-place';
  const source = seed(name);
  const placed = await install({ name, place: { dir: 'team/bundles/', mode: 'link' } });
  expect(placed.status, placed.body).toBe(200);
  expect(warningCodes(placed.body)).toContain('links-not-permitted');
  expect((JSON.parse(placed.body) as { warnings: string[] }).warnings).toEqual([
    'This system does not allow creating symlinks, so team/bundles got a copy instead of a link. On Windows, creating symlinks needs administrator rights or Developer Mode.',
  ]);
  expect(isRealDirWithSkill(join(root, 'team/bundles', name))).toBe(true);
  expect(placement(name, `team/bundles/${name}`)).toMatchObject({
    mode: 'copy',
    hash: parseSkillDir(source)?.contentHash,
  });
}, 60_000);

test('a custom-root add records the copy it made, with its hash', async () => {
  const name = 'eperm-root';
  const source = seed(name);
  const declared = await request('PUT', '/api/skill-targets', {
    folderAction: { action: 'add-root', scope: 'project', root: '.team/skills' },
  });
  expect(declared.status, declared.body).toBe(200);
  const add = await install({ name, add: ['.team/skills'] });
  expect(add.status, add.body).toBe(200);
  expect(warningCodes(add.body)).toContain('links-not-permitted');
  expect(isRealDirWithSkill(join(root, '.team/skills', name))).toBe(true);
  expect(placement(name, `.team/skills/${name}`)).toMatchObject({
    mode: 'copy',
    hash: parseSkillDir(source)?.contentHash,
  });
}, 60_000);

test('a link request over an existing custom-root copy keeps it recorded as a copy', async () => {
  const name = 'eperm-relink';
  const source = seed(name);
  const declared = await request('PUT', '/api/skill-targets', {
    folderAction: { action: 'add-root', scope: 'project', root: '.relink/skills' },
  });
  expect(declared.status, declared.body).toBe(200);
  const asCopy = await install({ name, add: ['.relink/skills'], mode: 'copy' });
  expect(asCopy.status, asCopy.body).toBe(200);
  const hash = parseSkillDir(source)?.contentHash;
  expect(placement(name, `.relink/skills/${name}`)).toMatchObject({ mode: 'copy', hash });

  const asLink = await install({ name, add: ['.relink/skills'], mode: 'link' });
  expect(asLink.status, asLink.body).toBe(200);
  expect(warningCodes(asLink.body)).toContain('links-not-permitted');
  expect((JSON.parse(asLink.body) as { warnings: string[] }).warnings).toContain(
    'This system does not allow creating symlinks, so .relink/skills got a copy instead of a link. On Windows, creating symlinks needs administrator rights or Developer Mode.',
  );
  expect(isRealDirWithSkill(join(root, '.relink/skills', name))).toBe(true);
  expect(placement(name, `.relink/skills/${name}`)).toMatchObject({ mode: 'copy', hash });
}, 60_000);
