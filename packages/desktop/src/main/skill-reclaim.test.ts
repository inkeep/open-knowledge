import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { reclaimProjectSkillsOnProjectOpen, reclaimUserSkillsOnLaunch } from './skill-reclaim.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

/** A `.mcp.json` body carrying the `# ok-mcp-v1` chain sentinel — the
 *  `createIfWired` signal the project sweep keys off. */
const OK_WIRED_MCP_JSON = JSON.stringify({
  mcpServers: {
    'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v1\nexec ok mcp'] },
  },
});
/** A `.mcp.json` with an unrelated server and no OK marker. */
const UNWIRED_MCP_JSON = JSON.stringify({ mcpServers: { other: { command: 'node' } } });
/** A `.mcp.json` carrying the WINDOWS chain sentinel — written by a Windows
 *  teammate into a shared repo; must still count as wired here. */
const OK_WIRED_MCP_JSON_WIN = JSON.stringify({
  mcpServers: {
    'open-knowledge': {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', '# ok-mcp-win-v1\nexit 127'],
    },
  },
});

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (!p) continue;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
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
  /** Captured state for assertions. */
  stateWrites: Array<{ home: string; version: string }>;
  events: CapturedEvent[];
  /** Captured per-bundle decisions written (grandfather materialization). */
  decisionWrites: Array<{ bundleName: string; enabled: boolean }>;
  /** Captured bundle ids removed on decline. */
  removals: string[];
}

/** Default test bundle set — discovery only, so existing single-bundle
 *  assertions hold; multi-bundle tests pass an explicit list. */
const DISCOVERY_ONLY_BUNDLES = [{ id: 'discovery', name: 'open-knowledge-discovery' }] as const;

function makeDeps(opts: {
  bundle: string;
  version?: string;
  versionThrows?: Error;
  resolveThrows?: Error;
  /** Inject a throw into the writeTargetVersion mock — exercises the
   *  state-write-failure → outcome:'failed' regression guard. */
  stateWriteThrows?: Error;
  /** Per-bundle opt-in decision the gate reads. Default `true` (consented) so
   *  existing install-assertion tests hold; `null` grandfathers to disk;
   *  `false` declines. A map keys by bundle NAME for multi-bundle tests. */
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

describe('reclaimUserSkillsOnLaunch', () => {
  test('skipped on AppImage launches (ephemeral mount path)', async () => {
    const home = makeHome();
    const deps = makeDeps({ bundle: setupBundle() });
    // AppImage launches decline every persistent-path integration — the
    // squashfs mount in executablePath is dead by next boot.
    const r = await reclaimUserSkillsOnLaunch({
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
    const r = await reclaimUserSkillsOnLaunch({
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
    await reclaimUserSkillsOnLaunch({
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
    await reclaimUserSkillsOnLaunch({
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
    await reclaimUserSkillsOnLaunch({
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
    // A `.claude` host so a per-host (non-central) write also happens.
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    const deps = {
      ...makeDeps({ bundle, version: '1.0.0' }),
      userGlobalBundles: [
        { id: 'discovery', name: 'open-knowledge-discovery' },
        { id: 'write-skill', name: 'open-knowledge-write-skill' },
      ],
    };
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    // Both bundles landed in the central store and the `.claude` host.
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      expect(existsSync(join(home, '.agents', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    }
    // One installed event per bundle; the version marker is written once.
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
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    // Present → skipped-present: existing content + files are preserved, and the
    // bundle's extra files are NOT injected. Updates flow through skills.sh.
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
    // .cursor intentionally missing
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const r = await reclaimUserSkillsOnLaunch({
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
    // Codex's per-host skills dir is now `.codex/skills` (not the shared
    // `.agents`). The all-agents central `.agents/skills/open-knowledge-discovery`
    // store and codex's per-host copy are distinct paths — both get written,
    // no collapse.
    const home = makeHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const events: Array<Record<string, unknown>> = [];
    const r = await reclaimUserSkillsOnLaunch({
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
      // Codex now produces its own host entry at `.codex`, distinct from central.
      const codex = r.entries.find((e) => e.kind === 'host' && e.editorId === 'codex');
      expect(codex?.status).toBe('written');
      expect(codex?.path).toContain(join('.codex', 'skills'));
      expect(codex?.path).not.toBe(central?.path);
    }
    // Both the central and the codex-host write fire (no collapse).
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
    const r = await reclaimUserSkillsOnLaunch({
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
    // Existing content is preserved — updates flow through the manual skills.sh
    // path, not this launch hook.
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('v-old');
  });

  test('pre-split open-knowledge dirs are removed at every host before the discovery bundle lands', async () => {
    const home = makeHome();
    const legacyHosts = ['.claude', '.cursor', '.agents'] as const;
    // Plant a stale pre-split install at all three host locations.
    for (const hostDir of legacyHosts) {
      const legacy = join(home, hostDir, 'skills', 'open-knowledge');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'SKILL.md'), '---\nname: open-knowledge\n---\n# legacy\n');
    }
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '1.2.3' });
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    for (const hostDir of legacyHosts) {
      // Legacy dir gone; the new discovery dir is present in its place.
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
    // Inject an fs whose every write throws — central + per-host replaceDir
    // all fail, so no write succeeds and the state file is never advanced.
    const r = await reclaimUserSkillsOnLaunch({
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
    // `.agents` absent (no central destination) and exactly one host root, so
    // each bundle has exactly one candidate destination: `~/.claude/skills/…`.
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
    const r = await reclaimUserSkillsOnLaunch({
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
        // Only the write-skill bundle's writes throw; discovery lands normally.
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
    // The sibling landed, but this bundle reached no destination at all.
    const writeSkillEvents = deps.events.filter((e) => e.bundle === 'write-skill');
    expect(writeSkillEvents).toHaveLength(1);
    expect(writeSkillEvents[0]?.outcome).toBe('failed');
    expect(writeSkillEvents[0]?.reason).toBe('all-targets-failed');
    expect(deps.events.some((e) => e.outcome === 'installed')).toBe(false);
    // Version stays unrecorded so the next launch retries the failed bundle.
    expect(deps.stateWrites).toEqual([]);
  });

  test('bundle-missing surfaces as skipped with failed event', async () => {
    const home = makeHome();
    const deps = makeDeps({
      bundle: '/does-not-matter',
      resolveThrows: new Error('not found'),
    });
    const r = await reclaimUserSkillsOnLaunch({
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
    const r = await reclaimUserSkillsOnLaunch({
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
    // Regression guard: a writeTargetVersion throw left the JSONL event
    // recording outcome:'installed' while ~/.ok/skill-state.yml stayed
    // pinned to a stale version — recreating the exact staleness symptom
    // this whole module is fixing. Gate the JSONL outcome on the state
    // write so the diagnostic trail stays coherent.
    const home = makeHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    const deps = makeDeps({
      bundle: setupBundle(),
      version: '1.2.3',
      stateWriteThrows: new Error('ENOSPC: no space left on device'),
    });
    const r = await reclaimUserSkillsOnLaunch({
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

describe('reclaimUserSkillsOnLaunch — per-bundle opt-in gate', () => {
  const DISCOVERY_DIR = ['.agents', 'skills', 'open-knowledge-discovery'] as const;

  function seedCentral(home: string): void {
    const dir = join(home, ...DISCOVERY_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
  }

  test('FR1: fresh machine (no decision, nothing on disk) installs nothing', async () => {
    const home = makeHome();
    const deps = makeDeps({ bundle: setupBundle(), bundleDecision: null });
    const r = await reclaimUserSkillsOnLaunch({
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
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('all-bundles-declined');
    expect(deps.removals).toEqual(['discovery']);
    // No install event for the declined bundle.
    expect(deps.events.some((e) => e.outcome === 'installed')).toBe(false);
  });

  test('FR4: grandfather — installed with no decision is kept + records enabled', async () => {
    const home = makeHome();
    seedCentral(home);
    const deps = makeDeps({ bundle: setupBundle(), version: '1.0.0', bundleDecision: null });
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    // Grandfathered install stays (seed-if-absent leaves it) + decision materialized.
    expect(existsSync(join(home, ...DISCOVERY_DIR, 'SKILL.md'))).toBe(true);
    expect(deps.decisionWrites).toEqual([
      { bundleName: 'open-knowledge-discovery', enabled: true },
    ]);
    expect(deps.removals).toEqual([]);
  });

  test('mixed decision: declined bundle is removed while the enabled bundle installs', async () => {
    const home = makeHome();
    // Seed only write-skill on disk (the one being declined+removed). Discovery
    // is absent so seed-if-absent freshly writes it → an install event fires;
    // a pre-present discovery would be a no-op under seed-if-absent.
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
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    // write-skill torn down; discovery installed (its central write landed).
    expect(deps.removals).toEqual(['write-skill']);
    const installed = deps.events.filter((e) => e.outcome === 'installed').map((e) => e.bundle);
    expect(installed).toEqual(['discovery']);
    // A DECLINED bundle must never be counted on skills.sh. It is torn off disk
    // and never installed, so reporting it would claim an install the user
    // explicitly refused. Only the enabled bundle that actually landed is sent.
    expect(deps.reports).toEqual([{ skills: ['open-knowledge-discovery'], scope: undefined }]);
  });

  test('a launch that installs nothing new reports nothing', async () => {
    // Steady state: the reclaim is seed-if-absent, so every bundle already on
    // disk reads `skipped-present`. Reporting there would turn an install
    // counter into a launch counter.
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

    await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });

    expect(deps.reports).toEqual([]);
  });
});

describe('reclaimProjectSkillsOnProjectOpen', () => {
  test('skipped on AppImage launches (ephemeral mount path)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: '/tmp/.mount_okXYZ/openknowledge',
      isPackaged: true,
      platform: 'linux',
      env: { APPIMAGE: '/home/u/OK.AppImage' },
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('appimage-ephemeral');
  });

  test('an explicit OFF in Settings is honoured — no resurrection on the next open', async () => {
    // The toggle used to be a lie: switch the project skill off, reopen the
    // project, and `createIfWired` put it back for every wired host.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'open-knowledge': { args: ['# ok-mcp-v2'] } } }),
    );

    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: {
        resolveBundledSkillDir: () => setupBundle(),
        readProjectSkillDecision: async () => false,
      },
    });

    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('declined-by-user');
    expect(existsSync(join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      false,
    );
  });

  test('creating the project skill counts one install, scoped to the project', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'open-knowledge': { args: ['# ok-mcp-v2'] } } }),
    );
    const reports: Array<{ skills: string[]; scope?: string }> = [];

    await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: {
        resolveBundledSkillDir: () => setupBundle(),
        reportInstalled: (skills, scope) => reports.push({ skills: [...skills], scope }),
      },
    });

    expect(reports).toEqual([{ skills: ['open-knowledge'], scope: projectDir }]);
  });

  test('reopening a project that already has the skill counts nothing', async () => {
    // The steady state. Counting here would make every project open an install.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const dest = join(projectDir, '.claude', 'skills', 'open-knowledge');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), 'already here');
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'open-knowledge': { args: ['# ok-mcp-v2'] } } }),
    );
    const reports: Array<{ skills: string[]; scope?: string }> = [];

    await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: {
        resolveBundledSkillDir: () => setupBundle(),
        reportInstalled: (skills, scope) => reports.push({ skills: [...skills], scope }),
      },
    });

    expect(reports).toEqual([]);
  });

  test('no SKILL.md on disk → no-token, no creation', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.every((e) => e.status === 'no-token')).toBe(true);
    }
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);
    expect(existsSync(join(projectDir, '.cursor'))).toBe(false);
    expect(existsSync(join(projectDir, '.agents'))).toBe(false);
  });

  test('codex project skill at .codex/skills/open-knowledge is left present, not overwritten', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const codexSkill = join(projectDir, '.codex', 'skills', 'open-knowledge');
    mkdirSync(codexSkill, { recursive: true });
    writeFileSync(join(codexSkill, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-old\n');
    const bundle = setupBundle();
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      deps: { resolveBundledSkillDir: () => bundle },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const codex = r.entries.find((e) => e.editorId === 'codex');
      expect(codex?.status).toBe('present');
    }
    expect(readFileSync(join(codexSkill, 'SKILL.md'), 'utf8')).toContain('v-old');
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);
  });

  test('seed-if-absent: existing project SKILL.md keeps its content', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const claudeSkill = join(projectDir, '.claude', 'skills', 'open-knowledge');
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-old\n');
    const bundle = setupBundle();
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      deps: { resolveBundledSkillDir: () => bundle },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const claude = r.entries.find((e) => e.editorId === 'claude');
      expect(claude?.status).toBe('present');
    }
    expect(readFileSync(join(claudeSkill, 'SKILL.md'), 'utf8')).toContain('v-old');
    // Other host stayed no-token.
    expect(existsSync(join(projectDir, '.cursor'))).toBe(false);
  });

  test('a host whose replaceDir throws is reported failed, not crashed', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
      // No SKILL.md on disk (existsSync false for skill files) but every host's
      // config reads back the OK marker → the create path fires for each; the
      // throwing mkdirSync then forces replaceDir to fail.
      fs: {
        existsSync: (p: string) => !String(p).endsWith('SKILL.md'),
        isDirectory: () => false,
        readdirSync: () => [],
        readFileSync: () => Buffer.from(OK_WIRED_MCP_JSON),
        writeFileSync: () => {
          throw new Error('EACCES: permission denied');
        },
        mkdirSync: () => {
          throw new Error('EACCES: permission denied');
        },
        rmSync: () => {},
      },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.length).toBeGreaterThan(0);
      expect(r.entries.every((e) => e.status === 'failed')).toBe(true);
    }
  });

  test('reclaim disable env short-circuits', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      reclaimDisableEnv: '1',
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('reclaim-disabled');
  });
});

describe('reclaimProjectSkillsOnProjectOpen — createIfWired (managed heal path)', () => {
  test('creates SKILL.md for a host wired for OK MCP but missing the skill', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    // Claude wired (`.mcp.json` carries the marker) but no skill on disk —
    // the exact MCP-but-no-skill cohort this heals. cursor/codex unwired.
    writeFileSync(join(projectDir, '.mcp.json'), OK_WIRED_MCP_JSON);
    const bundle = setupBundle();
    const events: Array<Record<string, unknown>> = [];
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => bundle },
      logger: { event: (e) => events.push(e), warn: () => {} },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.find((e) => e.editorId === 'claude')?.status).toBe('created');
      // The other hosts have no wired config → still no-token.
      expect(r.entries.find((e) => e.editorId === 'cursor')?.status).toBe('no-token');
      expect(r.entries.find((e) => e.editorId === 'codex')?.status).toBe('no-token');
    }
    const skillFile = join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf8')).toContain('v-new');
    expect(
      events.some((e) => e.event === 'project-skill-reclaim-created' && e.editorId === 'claude'),
    ).toBe(true);
  });

  test('creates SKILL.md for a host wired with the Windows chain sentinel', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    writeFileSync(join(projectDir, '.mcp.json'), OK_WIRED_MCP_JSON_WIN);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.find((e) => e.editorId === 'claude')?.status).toBe('created');
    }
    expect(existsSync(join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('creates SKILL.md for cursor host wired via .cursor/mcp.json', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeFileSync(join(projectDir, '.cursor', 'mcp.json'), OK_WIRED_MCP_JSON);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.find((e) => e.editorId === 'cursor')?.status).toBe('created');
      expect(r.entries.find((e) => e.editorId === 'claude')?.status).toBe('no-token');
    }
    expect(existsSync(join(projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('creates SKILL.md for codex host wired via .codex/config.toml (TOML, marker substring)', async () => {
    // Codex's wired signal lives in `.codex/config.toml` (TOML), and its skill
    // installs to `.codex/skills/open-knowledge/` — the config-path → skill-path
    // mapping a typo could silently break. The marker is a substring of the TOML
    // bytes, so the format-agnostic `includes` check detects it.
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(
      join(projectDir, '.codex', 'config.toml'),
      '[mcp_servers.open-knowledge]\ncommand = "/bin/sh"\nargs = ["-l", "-c", "# ok-mcp-v1\\nexec ok mcp"]\n',
    );
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.find((e) => e.editorId === 'codex')?.status).toBe('created');
      expect(r.entries.find((e) => e.editorId === 'claude')?.status).toBe('no-token');
    }
    expect(existsSync(join(projectDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('does NOT create when a host config exists but has no OK marker', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    // A `.mcp.json` with an unrelated server — host dir/config present, but the
    // editor is NOT wired for THIS OK project. Guards the gate against seeding
    // non-OK-wired editors.
    writeFileSync(join(projectDir, '.mcp.json'), UNWIRED_MCP_JSON);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.every((e) => e.status === 'no-token')).toBe(true);
    }
    expect(existsSync(join(projectDir, '.claude', 'skills'))).toBe(false);
  });

  test('without createIfWired, a wired host stays no-token (default no-create preserved)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    writeFileSync(join(projectDir, '.mcp.json'), OK_WIRED_MCP_JSON);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      // createIfWired omitted → defaults to false.
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.every((e) => e.status === 'no-token')).toBe(true);
    }
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);
  });

  test('existing SKILL.md is left present even when wired (never re-created)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const claudeSkill = join(projectDir, '.claude', 'skills', 'open-knowledge');
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-old\n');
    writeFileSync(join(projectDir, '.mcp.json'), OK_WIRED_MCP_JSON);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.find((e) => e.editorId === 'claude')?.status).toBe('present');
    }
    expect(readFileSync(join(claudeSkill, 'SKILL.md'), 'utf8')).toContain('v-old');
  });

  test('refuses to create through a host-dir symlink escaping the project', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    // `.claude` is a symlink to a directory OUTSIDE the project; a wired config
    // makes the create path eligible. The escape guard must fire BEFORE any
    // rm/copy so the symlink target stays untouched.
    const escapeTarget = mkdtempSync(join(tmpdir(), 'ok-escape-'));
    cleanupPaths.push(escapeTarget);
    const witness = join(escapeTarget, 'witness.txt');
    writeFileSync(witness, 'do-not-touch');
    symlinkSync(escapeTarget, join(projectDir, '.claude'));
    writeFileSync(join(projectDir, '.mcp.json'), OK_WIRED_MCP_JSON);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      createIfWired: true,
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      const claude = r.entries.find((e) => e.editorId === 'claude');
      expect(claude?.status).toBe('failed');
      expect(claude?.error ?? '').toMatch(/outside the project directory|symbolic link/i);
    }
    expect(readFileSync(witness, 'utf8')).toBe('do-not-touch');
  });
});
