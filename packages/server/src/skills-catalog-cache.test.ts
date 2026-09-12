import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getLogger } from './logger.ts';
import { createSkillsCatalogCache } from './skills-catalog-cache.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-catalog-owner-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function cache() {
  return createSkillsCatalogCache({ homeDirOverride: home, log: getLogger('cache-test') });
}

function writeSkill(dir: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: alpha\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

test('installed enumeration caches each project and home key until exactly five seconds', () => {
  const c = cache();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const initial = c.enumerateInstalledSkillsCached({ home });
  writeSkill(join(home, '.claude/skills/alpha'), 'added');
  clock.mockReturnValue(104_999);
  expect(c.enumerateInstalledSkillsCached({ home })).toBe(initial);
  clock.mockReturnValue(105_000);
  const refreshed = c.enumerateInstalledSkillsCached({ home });
  expect(refreshed.skills.some((s) => s.name === 'alpha')).toBe(true);
  expect(refreshed).not.toBe(initial);
  expect(c.enumerateInstalledSkillsCached({ home, projectDir: home })).not.toBe(refreshed);
  const otherHome = join(home, 'other');
  mkdirSync(otherHome);
  expect(c.enumerateInstalledSkillsCached({ home: otherHome }).skills).toEqual([]);
});

test('generation invalidation refreshes installed results while owners stay independent', () => {
  const a = cache();
  const b = cache();
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const initialA = a.enumerateInstalledSkillsCached({ home });
  const initialB = b.enumerateInstalledSkillsCached({ home });
  writeSkill(join(home, '.claude/skills/alpha'), 'added');
  a.bumpSkillsCatalogGen();
  const refreshed = a.enumerateInstalledSkillsCached({ home });
  expect(refreshed).not.toBe(initialA);
  expect(refreshed.skills.some((s) => s.name === 'alpha')).toBe(true);
  expect(b.enumerateInstalledSkillsCached({ home })).toBe(initialB);
});

test('list completion stamps the current generation and completion time', async () => {
  const c = cache();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(c.readList('fingerprint')).toBeNull();
  const completing = Promise.resolve().then(() =>
    c.writeList('fingerprint', { skills: ['alpha'] }),
  );
  c.bumpSkillsCatalogGen();
  clock.mockReturnValue(104_000);
  await completing;
  clock.mockReturnValue(108_999);
  expect(c.readList('fingerprint')?.body).toEqual({ skills: ['alpha'] });
  clock.mockReturnValue(109_000);
  expect(c.readList('fingerprint')).toBeNull();
});

test('list reads expose only the body and cannot replace the cached record', () => {
  const c = cache();
  const body = { skills: ['alpha'] };
  c.writeList('fingerprint', body);
  const hit = c.readList('fingerprint');
  expect(hit).toEqual({ body });
  expect(hit?.body).toBe(body);
  Object.assign(hit ?? {}, { body: { skills: ['replacement'] } });
  expect(c.readList('fingerprint')).toEqual({ body });
});

test('changed list fingerprints invalidate installed enumeration too', () => {
  const c = cache();
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  c.writeList('before', {});
  c.enumerateInstalledSkillsCached({ home });
  writeSkill(join(home, '.claude/skills/alpha'), 'added');
  expect(c.readList('after')).toBeNull();
  expect(c.enumerateInstalledSkillsCached({ home }).skills.some((s) => s.name === 'alpha')).toBe(
    true,
  );
});

function installPlugin(description: string): void {
  const installPath = join(home, '.claude/plugins/cache/team/eng/1.0.0');
  writeSkill(join(installPath, 'skills/alpha'), description);
  mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(installPath, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'eng', version: '1.0.0' }),
  );
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'eng@team': [{ scope: 'user', installPath, version: '1.0.0' }] },
    }),
  );
}

test('plugin content refreshes only on identity change or its independent thirty second expiry', () => {
  installPlugin('before');
  const c = cache();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const first = c.pluginSkillsByName('project-a');
  expect(first.get('alpha')).toBeDefined();
  const hash = first.get('alpha')?.contentHash;
  installPlugin('after');
  c.bumpSkillsCatalogGen();
  clock.mockReturnValue(129_999);
  expect(c.pluginSkillsByName('project-a')).toBe(first);
  clock.mockReturnValue(130_000);
  const expired = c.pluginSkillsByName('project-a');
  expect(expired.get('alpha')?.contentHash).not.toBe(hash);
  installPlugin('third');
  c.bumpSkillsCatalogGen();
  const changedIdentity = c.pluginSkillsByName('project-b');
  expect(changedIdentity.get('alpha')?.contentHash).not.toBe(expired.get('alpha')?.contentHash);
});
