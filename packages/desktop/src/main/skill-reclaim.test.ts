import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { reconcileUserGlobalSkillBundles } from './skill-reclaim.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (!p) continue;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function setupBundle(): string {
  const bundle = mkdtempSync(join(tmpdir(), 'ok-skill-bundle-'));
  cleanupPaths.push(bundle);
  writeFileSync(join(bundle, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-new\n');
  writeFileSync(join(bundle, 'extra.md'), 'extra-new');
  return bundle;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ok-skill-home-'));
  cleanupPaths.push(home);
  return home;
}

interface CapturedEvent {
  ts: string;
  outcome: 'installed' | 'failed';
  bundle?: string;
  version?: string;
  reason?: string;
}

interface FakeDeps {
  userGlobalBundles: ReadonlyArray<{ id: string; name: string }>;
  resolveBundledSkillDir(bundle: string): string;
  readServerPackageVersion(): Promise<string>;
  writeTargetVersion(
    home: string,
    target: 'cli-hosts',
    version: string,
    surface: 'desktop-direct',
  ): Promise<void>;
  recordSkillInstallEvent(event: {
    ts: string;
    surface: 'desktop-direct';
    target: 'cli-hosts';
    bundle?: string;
    outcome: 'installed' | 'failed';
    version?: string;
    reason?: string;
  }): Promise<void>;
  readBundleDecision(home: string, bundleName: string): Promise<boolean | null>;
  writeBundleDecision(home: string, bundleName: string, enabled: boolean): Promise<void>;
  removeBundleFromDisk(bundleId: string): void;
  stateWrites: Array<{ home: string; version: string }>;
  events: CapturedEvent[];
  decisionWrites: Array<{ bundleName: string; enabled: boolean }>;
  removals: string[];
}

const DISCOVERY_ONLY_BUNDLES = [{ id: 'discovery', name: 'open-knowledge-discovery' }] as const;

function makeDeps(opts: {
  bundle: string;
  version?: string;
  versionThrows?: Error;
  resolveThrows?: Error;
  stateWriteThrows?: Error;
  bundleDecision?: boolean | null | Record<string, boolean | null>;
}): FakeDeps {
  const stateWrites: Array<{ home: string; version: string }> = [];
  const events: CapturedEvent[] = [];
  const decisionWrites: Array<{ bundleName: string; enabled: boolean }> = [];
  const removals: string[] = [];
  const reports: Array<{ skills: string[]; scope?: string }> = [];
  const decisionFor = (bundleName: string): boolean | null => {
    const d = opts.bundleDecision;
    if (d === undefined) return true;
    if (typeof d === 'object' && d !== null) return d[bundleName] ?? null;
    return d;
  };
  return {
    userGlobalBundles: DISCOVERY_ONLY_BUNDLES,
    resolveBundledSkillDir: () => {
      if (opts.resolveThrows) throw opts.resolveThrows;
      return opts.bundle;
    },
    readServerPackageVersion: async () => {
      if (opts.versionThrows) throw opts.versionThrows;
      return opts.version ?? '9.9.9';
    },
    writeTargetVersion: async (home, _target, version) => {
      if (opts.stateWriteThrows) throw opts.stateWriteThrows;
      stateWrites.push({ home, version });
    },
    recordSkillInstallEvent: async (event) => {
      events.push({
        ts: event.ts,
        outcome: event.outcome,
        bundle: event.bundle,
        version: event.version,
        reason: event.reason,
      });
    },
    readBundleDecision: async (_home, bundleName) => decisionFor(bundleName),
    writeBundleDecision: async (_home, bundleName, enabled) => {
      decisionWrites.push({ bundleName, enabled });
    },
    removeBundleFromDisk: (bundleId) => {
      removals.push(bundleId);
    },
    reportInstalled: (skillNames: readonly string[], scope?: string) => {
      reports.push({ skills: [...skillNames], scope });
    },
    stateWrites,
    events,
    decisionWrites,
    removals,
    reports,
  };
}

describe('reconcileUserGlobalSkillBundles', () => {
  test('skipped on AppImage launches (ephemeral mount path)', async () => {
    const home = makeHome();
    const deps = makeDeps({ bundle: setupBundle() });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'linux',
      executablePath: '/tmp/.mount_okXYZ/openknowledge',
      env: { APPIMAGE: '/home/u/OK.AppImage' },
      deps,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('appimage-ephemeral');
  });

  test('linux deb install reaches done through the install-shape gate', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.0.0' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'linux',
      executablePath: '/opt/OpenKnowledge/openknowledge',
      deps,
    });
    expect(r.status).toBe('done');
    expect(
      existsSync(join(home, '.agents', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
  });

  test('launch repair does not create an absent .agents host', async () => {
    const home = makeHome();
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '0.5.0-beta.41' });
    await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    const central = join(home, '.agents', 'skills', 'open-knowledge-discovery', 'SKILL.md');
    expect(existsSync(central)).toBe(false);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });

  test('launch repair uses an existing Pi root without creating .agents', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.pi'), { recursive: true });
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '0.5.0-beta.41' });
    await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });

    expect(
      existsSync(join(home, '.pi', 'agent', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });

  test('grandfathers a bundle installed only in a concrete Pi root', async () => {
    const home = makeHome();
    const skillDir = join(home, '.pi', 'agent', 'skills', 'open-knowledge-discovery');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# existing');
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '0.5.0-beta.41', bundleDecision: null });
    await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });

    expect(deps.decisionWrites).toEqual([
      { bundleName: 'open-knowledge-discovery', enabled: true },
    ]);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });

  test('installs every user-global bundle (discovery + write-skill) into central + per-host', async () => {
    const home = makeHome();
    const bundle = setupBundle();
    mkdirSync(join(home, '.agents'), { recursive: true });
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    const deps = {
      ...makeDeps({ bundle, version: '1.0.0' }),
      userGlobalBundles: [
        { id: 'discovery', name: 'open-knowledge-discovery' },
        { id: 'write-skill', name: 'open-knowledge-write-skill' },
      ],
    };
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      expect(existsSync(join(home, '.agents', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    }
    const installed = deps.events.filter((e) => e.outcome === 'installed').map((e) => e.bundle);
    expect(installed.sort()).toEqual(['discovery', 'write-skill']);
    expect(deps.stateWrites).toEqual([{ home, version: '1.0.0' }]);
  });

  test('seed-if-absent: existing central store is left untouched (no overwrite)', async () => {
    const home = makeHome();
    const bundle = setupBundle();
    const central = join(home, '.agents', 'skills', 'open-knowledge-discovery');
    mkdirSync(central, { recursive: true });
    writeFileSync(join(central, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-old\n');
    writeFileSync(join(central, 'orphan.md'), 'stale');
    const deps = makeDeps({ bundle, version: '0.5.0-beta.41' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    expect(readFileSync(join(central, 'SKILL.md'), 'utf8')).toContain('v-old');
    expect(existsSync(join(central, 'orphan.md'))).toBe(true);
    expect(existsSync(join(central, 'extra.md'))).toBe(false);
    if (r.status === 'done') {
      expect(r.entries.find((e) => e.kind === 'central')?.status).toBe('skipped-present');
    }
  });

  test('per-host write happens only when the host dir exists; missing host is skipped-host-absent', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const claude = r.entries.find((e) => e.kind === 'host' && e.editorId === 'claude');
      const cursor = r.entries.find((e) => e.kind === 'host' && e.editorId === 'cursor');
      expect(claude?.status).toBe('written');
      expect(cursor?.status).toBe('skipped-host-absent');
    }
    expect(
      existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(home, '.cursor', 'skills', 'open-knowledge-discovery'))).toBe(false);
  });

  test('codex installs to its own .codex host dir, distinct from the .agents central store', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const events: Array<Record<string, unknown>> = [];
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
      logger: {
        event: (e) => events.push(e),
        warn: () => {},
      },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const central = r.entries.find((e) => e.kind === 'central');
      expect(central?.status).toBe('written');
      expect(central?.path).toContain(join('.agents', 'skills'));
      const codex = r.entries.find((e) => e.kind === 'host' && e.editorId === 'codex');
      expect(codex?.status).toBe('written');
      expect(codex?.path).toContain(join('.codex', 'skills'));
      expect(codex?.path).not.toBe(central?.path);
    }
    expect(events.filter((e) => e.event === 'user-skill-reclaim-central-written')).toHaveLength(1);
    expect(
      events.filter((e) => e.event === 'user-skill-reclaim-host-written' && e.editorId === 'codex'),
    ).toHaveLength(1);
  });

  test('seed-if-absent: existing per-host SKILL.md is left untouched (no force-write)', async () => {
    const home = makeHome();
    const dest = join(home, '.claude', 'skills', 'open-knowledge-discovery');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-old\n');
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const claude = r.entries.find((e) => e.kind === 'host' && e.editorId === 'claude');
      expect(claude?.status).toBe('skipped-present');
    }
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('v-old');
  });

  test('pre-split open-knowledge dirs are removed at every host before the discovery bundle lands', async () => {
    const home = makeHome();
    const legacyHosts = ['.claude', '.cursor', '.agents'] as const;
    for (const hostDir of legacyHosts) {
      const legacy = join(home, hostDir, 'skills', 'open-knowledge');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'SKILL.md'), '---\nname: open-knowledge\n---\n# legacy\n');
    }
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    for (const hostDir of legacyHosts) {
      expect(existsSync(join(home, hostDir, 'skills', 'open-knowledge'))).toBe(false);
      expect(
        existsSync(join(home, hostDir, 'skills', 'open-knowledge-discovery', 'SKILL.md')),
      ).toBe(true);
    }
  });

  test('every write failing → JSONL records outcome:failed reason:all-targets-failed', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    const deps = makeDeps({ bundle: setupBundle(), version: '3.2.1' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
      fs: {
        existsSync: (path) => existsSync(path),
        isDirectory: () => false,
        readdirSync: () => [],
        readFileSync: () => Buffer.from(''),
        writeFileSync: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        mkdirSync: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        rmSync: () => {},
      },
    });
    expect(r.status).toBe('done');
    expect(deps.stateWrites).toEqual([]);
    const failed = deps.events.find((e) => e.outcome === 'failed');
    expect(failed?.reason).toBe('all-targets-failed');
    expect(failed?.version).toBe('3.2.1');
  });

  test('a bundle that lands nowhere reports failed even when a sibling bundle succeeds', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const bundle = setupBundle();
    const deps = {
      ...makeDeps({ bundle, version: '4.5.6' }),
      userGlobalBundles: [
        { id: 'discovery', name: 'open-knowledge-discovery' },
        { id: 'write-skill', name: 'open-knowledge-write-skill' },
      ],
    };
    const failingBundleDir = 'open-knowledge-write-skill';
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
      fs: {
        existsSync: (path) => existsSync(path),
        isDirectory: (path) => {
          try {
            return statSync(path).isDirectory();
          } catch {
            return false;
          }
        },
        readdirSync: (path) => readdirSync(path),
        readFileSync: (path) => readFileSync(path),
        writeFileSync: (path, content) => {
          if (path.includes(failingBundleDir)) throw new Error('synthetic: EACCES');
          writeFileSync(path, content);
        },
        mkdirSync: (path, options) => {
          mkdirSync(path, options);
        },
        rmSync: (path, options) => {
          rmSync(path, options);
        },
      },
    });

    expect(r.status).toBe('done');
    expect(
      existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
    const writeSkillEvents = deps.events.filter((e) => e.bundle === 'write-skill');
    expect(writeSkillEvents).toHaveLength(1);
    expect(writeSkillEvents[0]?.outcome).toBe('failed');
    expect(writeSkillEvents[0]?.reason).toBe('all-targets-failed');
    expect(deps.events.some((e) => e.outcome === 'installed')).toBe(false);
    expect(deps.stateWrites).toEqual([]);
  });

  test('bundle-missing surfaces as skipped with failed event', async () => {
    const home = makeHome();
    const deps = makeDeps({
      bundle: '/does-not-matter',
      resolveThrows: new Error('not found'),
    });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('skipped');
    expect(deps.events[0]?.outcome).toBe('failed');
    expect(deps.stateWrites).toEqual([]);
  });

  test('version-read failure surfaces as skipped; no state-write', async () => {
    const home = makeHome();
    const deps = makeDeps({ bundle: setupBundle(), versionThrows: new Error('bad pkg') });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('skipped');
    expect(deps.stateWrites).toEqual([]);
    expect(deps.events.at(-1)?.outcome).toBe('failed');
  });

  test('writeTargetVersion failure → JSONL outcome:failed (not installed) so event log matches state file', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    const deps = makeDeps({
      bundle: setupBundle(),
      version: '1.2.3',
      stateWriteThrows: new Error('ENOSPC: no space left on device'),
    });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    expect(deps.stateWrites).toEqual([]);
    const installed = deps.events.find((e) => e.outcome === 'installed');
    expect(installed).toBeUndefined();
    const failed = deps.events.find((e) => e.outcome === 'failed');
    expect(failed?.version).toBe('1.2.3');
    expect(failed?.reason ?? '').toContain('state-write-failed');
    expect(failed?.reason ?? '').toContain('ENOSPC');
  });
});

describe('reconcileUserGlobalSkillBundles — per-bundle opt-in gate', () => {
  const DISCOVERY_DIR = ['.agents', 'skills', 'open-knowledge-discovery'] as const;

  function seedCentral(home: string): void {
    const dir = join(home, ...DISCOVERY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
  }

  test('FR1: fresh machine (no decision, nothing on disk) installs nothing', async () => {
    const home = makeHome();
    const deps = makeDeps({ bundle: setupBundle(), bundleDecision: null });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('all-bundles-declined');
    expect(existsSync(join(home, ...DISCOVERY_DIR, 'SKILL.md'))).toBe(false);
    expect(deps.events.some((e) => e.outcome === 'installed')).toBe(false);
  });

  test('D3b: declining an installed bundle removes it and does not re-install', async () => {
    const home = makeHome();
    seedCentral(home);
    const deps = makeDeps({ bundle: setupBundle(), bundleDecision: false });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('all-bundles-declined');
    expect(deps.removals).toEqual(['discovery']);
    expect(deps.events.some((e) => e.outcome === 'installed')).toBe(false);
  });

  test('FR4: grandfather — installed with no decision is kept + records enabled', async () => {
    const home = makeHome();
    seedCentral(home);
    const deps = makeDeps({ bundle: setupBundle(), version: '1.0.0', bundleDecision: null });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    expect(existsSync(join(home, ...DISCOVERY_DIR, 'SKILL.md'))).toBe(true);
    expect(deps.decisionWrites).toEqual([
      { bundleName: 'open-knowledge-discovery', enabled: true },
    ]);
    expect(deps.removals).toEqual([]);
  });

  test('mixed decision: declined bundle is removed while the enabled bundle installs', async () => {
    const home = makeHome();
    {
      const dir = join(home, '.agents', 'skills', 'open-knowledge-write-skill');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    }
    const deps = {
      ...makeDeps({
        bundle: setupBundle(),
        version: '1.0.0',
        bundleDecision: {
          'open-knowledge-discovery': true,
          'open-knowledge-write-skill': false,
        },
      }),
      userGlobalBundles: [
        { id: 'discovery', name: 'open-knowledge-discovery' },
        { id: 'write-skill', name: 'open-knowledge-write-skill' },
      ],
    };
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    expect(deps.removals).toEqual(['write-skill']);
    const installed = deps.events.filter((e) => e.outcome === 'installed').map((e) => e.bundle);
    expect(installed).toEqual(['discovery']);
    expect(deps.reports).toEqual([{ skills: ['open-knowledge-discovery'], scope: undefined }]);
  });

  test('a launch that installs nothing new reports nothing', async () => {
    const home = makeHome();
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      const dir = join(home, '.agents', 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    }
    const deps = {
      ...makeDeps({ bundle: setupBundle(), version: '1.0.0' }),
      userGlobalBundles: [
        { id: 'discovery', name: 'open-knowledge-discovery' },
        { id: 'write-skill', name: 'open-knowledge-write-skill' },
      ],
    };

    await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });

    expect(deps.reports).toEqual([]);
  });
});

describe('seed: false', () => {
  test('reconciles only: no bundle is written and no state is recorded', async () => {
    const home = makeHome();
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.0.0' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'linux',
      executablePath: '/opt/OpenKnowledge/openknowledge',
      deps,
      seed: false,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('reconcile-only');
    expect(existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery'))).toBe(false);
    expect(deps.stateWrites).toEqual([]);
  });

  test('reconcile-only still removes the legacy open-knowledge user skill folder', async () => {
    const home = makeHome();
    const legacy = join(home, '.claude', 'skills', 'open-knowledge');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'SKILL.md'), 'legacy');
    const deps = makeDeps({ bundle: setupBundle(), version: '1.0.0' });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
      seed: false,
    });
    expect(r.status).toBe('skipped');
    expect(existsSync(legacy)).toBe(false);
  });

  test('reconcile-only still removes a bundle the user declined', async () => {
    const home = makeHome();
    const dir = join(home, '.agents', 'skills', 'open-knowledge-discovery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    const deps = makeDeps({ bundle: setupBundle(), bundleDecision: false });
    const r = await reconcileUserGlobalSkillBundles({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
      seed: false,
    });
    expect(r.status).toBe('skipped');
    expect(deps.removals).toEqual(['discovery']);
    expect(deps.stateWrites).toEqual([]);
  });
});
