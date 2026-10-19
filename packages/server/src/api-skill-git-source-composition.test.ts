import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import {
  type ServedGitRepos,
  serveGitRepos,
} from '../../../test-support/served-git-repos.test-helper.ts';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';

const OUTSIDE_SKILLS_BYTES = 2_000_000;
const LARGE_SKILL_MD_BYTES = 1_000_000;
const skillMd = (name: string, revision = 'first') =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${revision} revision of ${name}.\n`;

function publishTeamRepo(repo: string, folders: Readonly<Record<string, string>>): string {
  const files: Record<string, string | Buffer> = {
    'README.md': 'Team skills\n',
    'assets/blob.bin': randomBytes(OUTSIDE_SKILLS_BYTES),
  };
  for (const [folder, name] of Object.entries(folders)) {
    files[`${folder}/SKILL.md`] = skillMd(name);
    files[`${folder}/references/guide.md`] = `${name} guide\n`;
  }
  repos.publish(repo, files);
  return repo;
}

let root: string;
let server: BootedServer;
let repos: ServedGitRepos;

beforeAll(async () => {
  repos = await serveGitRepos();
  root = mkdtempSync(join(tmpdir(), 'ok-git-source-contract-'));
  mkdirSync(join(root, '.claude'));
  server = await bootCompositionRig(root);
  await server.ready;
}, 60_000);

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(repos.githubRedirectEnv())) vi.stubEnv(name, value);
  repos.resetBytesServed();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await server?.destroy();
  await repos?.close();
  rmSync(root, { recursive: true, force: true });
});

async function post(path: string, body: object) {
  const result = await rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(result.status, result.body).toBe(200);
  return JSON.parse(result.body);
}

const lockPath = () => join(root, '.ok/skills-lock.json');

function lockEntry(name: string): Record<string, unknown> | undefined {
  return JSON.parse(readFileSync(lockPath(), 'utf8')).skills[name];
}

function forgetRecordedFolder(name: string): void {
  const lock = JSON.parse(readFileSync(lockPath(), 'utf8'));
  delete lock.skills[name].subpath;
  writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);
}

const installed = (name: string, file = 'SKILL.md') =>
  readFileSync(join(root, '.claude/skills', name, file), 'utf8');

test('the picker lists a repository by name without downloading it whole', async () => {
  const repo = publishTeamRepo('fixture-org/listing', {
    'skills/alpha': 'alpha',
    'skills/beta': 'beta',
    'skills/beta/upstream': 'nested',
    'tools/scripts/helper': 'helper',
    'plugins/eng/skills/gamma': 'gamma',
    'archive/one/dup': 'dup',
    'archive/two/dup': 'dup',
  });
  repos.resetBytesServed();
  const result = await rawRequest(
    server.port,
    `/api/skills/discover?source=${encodeURIComponent(repo)}`,
  );
  expect(result.status, result.body).toBe(200);
  expect(JSON.parse(result.body).skills).toEqual([
    { name: 'alpha', description: 'alpha skill' },
    { name: 'beta', description: 'beta skill' },
    { name: 'dup', description: 'dup skill' },
    { name: 'dup', description: 'dup skill' },
    { name: 'gamma', description: 'gamma skill' },
  ]);
  expect(repos.bytesServed()).toBeGreaterThan(0);
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});

test('importing a repository by name and picking a skill records its folder and downloads only that folder', async () => {
  const repo = publishTeamRepo('fixture-org/import', {
    'plugins/eng/skills/imp-gamma': 'imp-gamma',
    'skills/imp-other': 'imp-other',
  });
  repos.resetBytesServed();
  const result = await post('/api/skill/import', {
    source: repo,
    skill: 'imp-gamma',
    install: false,
  });
  expect(result).toMatchObject({ name: 'imp-gamma', created: true, provenance: { source: repo } });
  expect(installed('imp-gamma')).toBe(skillMd('imp-gamma'));
  expect(installed('imp-gamma', 'references/guide.md')).toBe('imp-gamma guide\n');
  expect(existsSync(join(root, '.claude/skills/imp-other'))).toBe(false);
  expect(lockEntry('imp-gamma')).toMatchObject({
    source: repo,
    skill: 'imp-gamma',
    subpath: 'plugins/eng/skills/imp-gamma',
  });
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});

test('a source that already names a folder is recorded as before, without a separate folder', async () => {
  const repo = publishTeamRepo('fixture-org/named', { 'skills/named-alpha': 'named-alpha' });
  repos.resetBytesServed();
  const source = `${repo}/skills/named-alpha`;
  const result = await post('/api/skill/import', { source, install: false });
  expect(result).toMatchObject({ name: 'named-alpha', provenance: { source } });
  expect(installed('named-alpha', 'references/guide.md')).toBe('named-alpha guide\n');
  const entry = lockEntry('named-alpha');
  expect(entry).toMatchObject({ source, skill: 'named-alpha' });
  expect(entry).not.toHaveProperty('subpath');
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});

test('the update check and update of a skill with a recorded folder fetch only that folder', async () => {
  const repo = publishTeamRepo('fixture-org/update', { 'skills/upd-beta': 'upd-beta' });
  repos.publish(repo, {
    'skills/upd-large/SKILL.md': `${skillMd('upd-large')}\n${randomBytes(LARGE_SKILL_MD_BYTES).toString('base64')}\n`,
  });
  await post('/api/skill/import', { source: repo, skill: 'upd-beta', install: false });
  repos.publish(repo, { 'skills/upd-beta/SKILL.md': skillMd('upd-beta', 'second') });
  const lockBefore = readFileSync(lockPath(), 'utf8');
  repos.resetBytesServed();

  const check = await post('/api/skill/reimport', {
    name: 'upd-beta',
    scope: 'project',
    dryRun: true,
  });
  expect(check).toMatchObject({ updated: true });
  expect(check.upstreamBody).toContain('second revision of upd-beta.');
  expect(readFileSync(lockPath(), 'utf8')).toBe(lockBefore);
  expect(repos.bytesServed()).toBeLessThan(LARGE_SKILL_MD_BYTES);

  repos.resetBytesServed();
  expect(await post('/api/skill/reimport', { name: 'upd-beta', scope: 'project' })).toMatchObject({
    updated: true,
    source: repo,
  });
  expect(installed('upd-beta')).toBe(skillMd('upd-beta', 'second'));
  expect(lockEntry('upd-beta')).toMatchObject({ subpath: 'skills/upd-beta' });
  expect(repos.bytesServed()).toBeLessThan(LARGE_SKILL_MD_BYTES);
});

test('an import recorded without a folder keeps a fast update check and gains its folder at its next update', async () => {
  const repo = publishTeamRepo('fixture-org/legacy', {
    'skills/leg-alpha': 'leg-alpha',
    'skills/leg-other': 'leg-other',
  });
  await post('/api/skill/import', { source: repo, skill: 'leg-alpha', install: false });
  forgetRecordedFolder('leg-alpha');
  repos.publish(repo, { 'skills/leg-alpha/SKILL.md': skillMd('leg-alpha', 'second') });
  const lockBefore = readFileSync(lockPath(), 'utf8');
  repos.resetBytesServed();

  const check = await post('/api/skill/reimport', {
    name: 'leg-alpha',
    scope: 'project',
    dryRun: true,
  });
  expect(check).toMatchObject({ updated: true });
  expect(readFileSync(lockPath(), 'utf8')).toBe(lockBefore);
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);

  repos.resetBytesServed();
  expect(await post('/api/skill/reimport', { name: 'leg-alpha', scope: 'project' })).toMatchObject({
    updated: true,
  });
  expect(installed('leg-alpha')).toBe(skillMd('leg-alpha', 'second'));
  expect(installed('leg-alpha', 'references/guide.md')).toBe('leg-alpha guide\n');
  expect(lockEntry('leg-alpha')).toMatchObject({ subpath: 'skills/leg-alpha' });
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});

test('an import recorded without a folder whose name matches two folders is not given one', async () => {
  const repo = publishTeamRepo('fixture-org/ambiguous', {
    'archive/one/amb-dup': 'amb-dup',
    'archive/two/amb-dup': 'amb-dup',
  });
  await post('/api/skill/import', { source: repo, skill: 'amb-dup', install: false });
  forgetRecordedFolder('amb-dup');
  repos.publish(repo, {
    'archive/one/amb-dup/SKILL.md': skillMd('amb-dup', 'second'),
    'archive/two/amb-dup/SKILL.md': skillMd('amb-dup', 'second'),
  });
  expect(await post('/api/skill/reimport', { name: 'amb-dup', scope: 'project' })).toMatchObject({
    updated: true,
  });
  expect(installed('amb-dup')).toBe(skillMd('amb-dup', 'second'));
  expect(lockEntry('amb-dup')).not.toHaveProperty('subpath');
});

test('a recorded folder that moved is found again by name and recorded anew', async () => {
  const repo = publishTeamRepo('fixture-org/moved', {
    'plugins/eng/skills/mov-gamma': 'mov-gamma',
  });
  await post('/api/skill/import', { source: repo, skill: 'mov-gamma', install: false });
  expect(lockEntry('mov-gamma')).toMatchObject({ subpath: 'plugins/eng/skills/mov-gamma' });
  repos.publish(repo, {
    'plugins/eng/skills/mov-gamma': null,
    'plugins/ops/skills/mov-gamma/SKILL.md': skillMd('mov-gamma', 'moved'),
  });
  expect(await post('/api/skill/reimport', { name: 'mov-gamma', scope: 'project' })).toMatchObject({
    updated: true,
  });
  expect(installed('mov-gamma')).toBe(skillMd('mov-gamma', 'moved'));
  expect(lockEntry('mov-gamma')).toMatchObject({ subpath: 'plugins/ops/skills/mov-gamma' });
});

test('a recorded folder that is gone, whose name now matches two folders, is not kept in the lock entry', async () => {
  const repo = publishTeamRepo('fixture-org/gone-ambiguous', {
    'archive/one/gone-dup': 'gone-dup',
  });
  await post('/api/skill/import', { source: repo, skill: 'gone-dup', install: false });
  expect(lockEntry('gone-dup')).toMatchObject({ subpath: 'archive/one/gone-dup' });
  repos.publish(repo, {
    'archive/one/gone-dup': null,
    'archive/two/gone-dup/SKILL.md': skillMd('gone-dup', 'second'),
    'archive/three/gone-dup/SKILL.md': skillMd('gone-dup', 'second'),
  });
  expect(await post('/api/skill/reimport', { name: 'gone-dup', scope: 'project' })).toMatchObject({
    updated: true,
  });
  expect(installed('gone-dup')).toBe(skillMd('gone-dup', 'second'));
  const entry = lockEntry('gone-dup');
  expect(entry).toMatchObject({ source: repo, skill: 'gone-dup' });
  expect(entry).not.toHaveProperty('subpath');
});

test('Update all from this source fetches only the folders of the skills it updates', async () => {
  const repo = publishTeamRepo('fixture-org/update-all', {
    'skills/all-one': 'all-one',
    'plugins/eng/skills/all-two': 'all-two',
  });
  await post('/api/skill/import', { source: repo, skill: 'all-one', install: false });
  await post('/api/skill/import', { source: repo, skill: 'all-two', install: false });
  forgetRecordedFolder('all-two');
  repos.publish(repo, {
    'skills/all-one/SKILL.md': skillMd('all-one', 'second'),
    'plugins/eng/skills/all-two/SKILL.md': skillMd('all-two', 'second'),
  });
  repos.resetBytesServed();
  const result = await post('/api/skills/reimport-bulk', {
    names: ['all-one', 'all-two'],
    scope: 'project',
  });
  expect(result).toMatchObject({ updated: 2, failed: 0 });
  expect(installed('all-one')).toBe(skillMd('all-one', 'second'));
  expect(installed('all-two')).toBe(skillMd('all-two', 'second'));
  expect(lockEntry('all-one')).toMatchObject({ subpath: 'skills/all-one' });
  expect(lockEntry('all-two')).toMatchObject({ subpath: 'plugins/eng/skills/all-two' });
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});

test('a bulk import by repository name records each folder and downloads only those folders', async () => {
  const repo = publishTeamRepo('fixture-org/bulk-import', {
    'skills/bulk-one': 'bulk-one',
    'plugins/eng/skills/bulk-two': 'bulk-two',
  });
  repos.resetBytesServed();
  const result = await post('/api/skills/import-bulk', {
    source: repo,
    skills: ['bulk-one', 'bulk-two', 'missing'],
    install: false,
  });
  expect(result).toMatchObject({ imported: 2, failed: 1 });
  expect(installed('bulk-two', 'references/guide.md')).toBe('bulk-two guide\n');
  expect(lockEntry('bulk-one')).toMatchObject({ source: repo, subpath: 'skills/bulk-one' });
  expect(lockEntry('bulk-two')).toMatchObject({
    source: repo,
    subpath: 'plugins/eng/skills/bulk-two',
  });
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});

test('a recorded folder that would leave the repository is ignored, and the skill is found by name', async () => {
  const repo = publishTeamRepo('fixture-org/escape', { 'skills/esc-alpha': 'esc-alpha' });
  await post('/api/skill/import', { source: repo, skill: 'esc-alpha', install: false });
  const lock = JSON.parse(readFileSync(lockPath(), 'utf8'));
  lock.skills['esc-alpha'].subpath = '../../../../../../etc';
  writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);
  repos.publish(repo, { 'skills/esc-alpha/SKILL.md': skillMd('esc-alpha', 'second') });
  repos.resetBytesServed();

  const check = await post('/api/skill/reimport', {
    name: 'esc-alpha',
    scope: 'project',
    dryRun: true,
  });
  expect(check).toMatchObject({ updated: true });
  expect(check.upstreamBody).toContain('second revision of esc-alpha.');
  expect(repos.bytesServed()).toBeLessThan(OUTSIDE_SKILLS_BYTES);
});
