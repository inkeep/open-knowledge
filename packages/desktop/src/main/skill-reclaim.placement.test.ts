import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { reclaimUserSkillsOnLaunch } from './skill-reclaim.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
const BUNDLES = [{ id: 'discovery', name: 'open-knowledge-discovery' }] as const;
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

function bundleDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ok-placement-bundle-'));
  cleanup.push(d);
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${NAME}\n---\n# body\n`);
  return d;
}

function homeWithAllHosts(): string {
  const h = mkdtempSync(join(tmpdir(), 'ok-placement-home-'));
  cleanup.push(h);
  for (const [hostDir] of HOSTS) mkdirSync(join(h, hostDir), { recursive: true });
  mkdirSync(join(h, '.agents'), { recursive: true });
  return h;
}

const dest = (home: string, root: string) => join(home, root, NAME);

function installAt(home: string, root: string): void {
  const dir = dest(home, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${NAME}\n---\n# body\n`);
}

function run(home: string, bundle: string) {
  return reclaimUserSkillsOnLaunch({
    home,
    isPackaged: true,
    platform: 'darwin',
    executablePath: EXE,
    deps: {
      userGlobalBundles: BUNDLES,
      resolveBundledSkillDir: () => bundle,
      readServerPackageVersion: async () => '9.9.9',
      writeTargetVersion: async () => {},
      recordSkillInstallEvent: async () => {},
      readBundleDecision: async () => true,
      writeBundleDecision: async () => {},
      removeBundleFromDisk: () => {},
    },
    logger: { event: () => {}, warn: () => {} },
  });
}

describe('reclaimUserSkillsOnLaunch placement', () => {
  test('seeds the default host set when the bundle is nowhere (first run)', async () => {
    const home = homeWithAllHosts();

    await run(home, bundleDir());

    for (const [, root] of HOSTS) expect(existsSync(dest(home, root))).toBe(true);
    expect(existsSync(dest(home, '.agents/skills'))).toBe(true);
  });

  test('hub-only stays hub-only — no host copies are topped up', async () => {
    const home = homeWithAllHosts();
    installAt(home, '.agents/skills');

    await run(home, bundleDir());

    expect(existsSync(dest(home, '.agents/skills'))).toBe(true);
    for (const [, root] of HOSTS) expect(existsSync(dest(home, root))).toBe(false);
  });

  test('an uninstall from one agent survives the next launch', async () => {
    const home = homeWithAllHosts();
    installAt(home, '.agents/skills');
    for (const [, root] of HOSTS) installAt(home, root);
    rmSync(dest(home, '.codex/skills'), { recursive: true, force: true });

    await run(home, bundleDir());

    expect(existsSync(dest(home, '.codex/skills'))).toBe(false);
    expect(existsSync(dest(home, '.claude/skills'))).toBe(true);
  });

  test('removing every copy re-seeds — the presence guarantee still holds', async () => {
    const home = homeWithAllHosts();
    const bundle = bundleDir();
    await run(home, bundle);

    rmSync(dest(home, '.agents/skills'), { recursive: true, force: true });
    for (const [, root] of HOSTS) rmSync(dest(home, root), { recursive: true, force: true });

    await run(home, bundle);

    expect(existsSync(dest(home, '.agents/skills'))).toBe(true);
    expect(existsSync(dest(home, '.claude/skills'))).toBe(true);
  });

  test('a host installed later is not auto-seeded', async () => {
    const home = homeWithAllHosts();
    const bundle = bundleDir();
    installAt(home, '.agents/skills');
    installAt(home, '.claude/skills');
    const newHost = join(home, '.opencode');
    mkdirSync(dirname(newHost), { recursive: true });

    await run(home, bundle);

    expect(existsSync(dest(home, '.opencode/skills'))).toBe(false);
  });
});
