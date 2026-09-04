import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { repairSkills } from './repair-skills.ts';

const NAME = 'open-knowledge-discovery';

const HOSTS: Array<[string, string]> = [
  ['.claude', '.claude/skills'],
  ['.cursor', '.cursor/skills'],
  ['.codex', '.codex/skills'],
  ['.copilot', '.copilot/skills'],
  ['.opencode', '.opencode/skills'],
  ['.pi', '.pi/agent/skills'],
  ['.gemini', '.gemini/skills'],
  ['.lmstudio', '.lmstudio/skills'],
];

test('HOSTS mirrors USER_SKILL_HOSTS', () => {
  expect([...HOSTS].map(([, root]) => root).sort()).toEqual(
    USER_SKILL_HOSTS.map((h) => h.skillsRoot).sort(),
  );
});

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratch(): { home: string; project: string; bundle: string } {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-placement-'));
  cleanup.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  const bundle = join(root, 'bundle');
  for (const [hostDir] of HOSTS) mkdirSync(join(home, hostDir), { recursive: true });
  mkdirSync(join(home, '.agents'), { recursive: true });
  mkdirSync(join(project, '.ok'), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'SKILL.md'), `---\nname: ${NAME}\n---\n# body\n`);
  return { home, project, bundle };
}

function deps(bundle: string) {
  return {
    resolveProjectBundledSkillDir: () => bundle,
    resolveUserBundledSkillDir: () => bundle,
    readBundledVersion: async () => '9.9.9',
    readRecordedVersion: async () => null,
    writeRecordedVersion: async () => {},
    recordEvent: async () => {},
    readBundleDecision: async () => true,
    writeBundleDecision: async () => {},
    removeBundleFromDisk: () => {},
  };
}

const dest = (home: string, root: string) => join(home, root, NAME);

function installAt(home: string, root: string): void {
  const dir = dest(home, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${NAME}\n---\n# body\n`);
}

const sweep = (s: { home: string; project: string; bundle: string }) =>
  repairSkills({
    projectDir: s.project,
    home: s.home,
    logger: () => {},
    deps: deps(s.bundle),
  });

describe('repairSkills user sweep placement', () => {
  test('seeds the default host set when the bundle is nowhere', async () => {
    const s = scratch();

    await sweep(s);

    for (const [, root] of HOSTS) expect(existsSync(dest(s.home, root))).toBe(true);
    expect(existsSync(dest(s.home, '.agents/skills'))).toBe(true);
  });

  test('hub-only stays hub-only', async () => {
    const s = scratch();
    installAt(s.home, '.agents/skills');

    await sweep(s);

    expect(existsSync(dest(s.home, '.agents/skills'))).toBe(true);
    for (const [, root] of HOSTS) expect(existsSync(dest(s.home, root))).toBe(false);
  });

  test('an uninstalled agent is not re-seeded', async () => {
    const s = scratch();
    installAt(s.home, '.agents/skills');
    for (const [, root] of HOSTS) installAt(s.home, root);
    rmSync(dest(s.home, '.codex/skills'), { recursive: true, force: true });

    await sweep(s);

    expect(existsSync(dest(s.home, '.codex/skills'))).toBe(false);
    expect(existsSync(dest(s.home, '.claude/skills'))).toBe(true);
  });
});
