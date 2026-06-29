import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reclaimProjectSkillsOnProjectOpen, reclaimUserSkillsOnLaunch } from './skill-reclaim.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

/** A `.mcp.json` body carrying the `# ok-mcp-v1` chain sentinel — the
 *  `createIfWired` signal the project sweep keys off. */
const OK_WIRED_MCP_JSON = JSON.stringify({
  mcpServers: {
    'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v1\nexec ok mcp'] },
  },
});
const UNWIRED_MCP_JSON = JSON.stringify({ mcpServers: { other: { command: 'node' } } });

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (!p) continue;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
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
  stateWrites: Array<{ home: string; version: string }>;
  events: CapturedEvent[];
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
}): FakeDeps {
  const stateWrites: Array<{ home: string; version: string }> = [];
  const events: CapturedEvent[] = [];
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
    stateWrites,
    events,
  };
}

describe('reclaimUserSkillsOnLaunch', () => {
  test('skipped on non-darwin', async () => {
    const home = makeHome();
    const deps = makeDeps({ bundle: setupBundle() });
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'linux',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('skipped');
  });

  test('central store always force-written even when nothing existed', async () => {
    const home = makeHome();
    const bundle = setupBundle();
    const deps = makeDeps({ bundle, version: '0.5.0-beta.41' });
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
    });
    expect(r.status).toBe('done');
    const central = join(home, '.agents', 'skills', 'open-knowledge-discovery', 'SKILL.md');
    expect(existsSync(central)).toBe(true);
    expect(readFileSync(central, 'utf8')).toContain('v-new');
    expect(deps.stateWrites).toEqual([{ home, version: '0.5.0-beta.41' }]);
    expect(deps.events).toEqual([
      {
        ts: deps.events[0]?.ts ?? '',
        outcome: 'installed',
        bundle: 'discovery',
        version: '0.5.0-beta.41',
      },
    ]);
  });

  test('installs every user-global bundle (discovery + write-skill) into central + per-host', async () => {
    const home = makeHome();
    const bundle = setupBundle();
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
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      expect(existsSync(join(home, '.agents', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    }
    const installed = deps.events.filter((e) => e.outcome === 'installed').map((e) => e.bundle);
    expect(installed.sort()).toEqual(['discovery', 'write-skill']);
    expect(deps.stateWrites).toEqual([{ home, version: '1.0.0' }]);
  });

  test('central store overwrites existing files even when same path is present', async () => {
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
    expect(readFileSync(join(central, 'SKILL.md'), 'utf8')).toContain('v-new');
    expect(existsSync(join(central, 'orphan.md'))).toBe(false);
    expect(existsSync(join(central, 'extra.md'))).toBe(true);
  });

  test('per-host write happens only when the host dir exists; missing host is skipped-host-absent', async () => {
    const home = makeHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
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
    const home = makeHome();
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

  test('per-host overwrite when SKILL.md already exists (force-write)', async () => {
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
      expect(claude?.status).toBe('overwritten');
    }
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('v-new');
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
    const r = await reclaimUserSkillsOnLaunch({
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
    const deps = makeDeps({ bundle: setupBundle(), version: '3.2.1' });
    const r = await reclaimUserSkillsOnLaunch({
      home,
      isPackaged: true,
      platform: 'darwin',
      executablePath: EXE,
      deps,
      fs: {
        existsSync: () => false,
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
    const home = makeHome();
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

describe('reclaimProjectSkillsOnProjectOpen', () => {
  test('skipped on non-darwin', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'linux',
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('skipped');
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

  test('codex project skill at .codex/skills/open-knowledge is reclaimed when present', async () => {
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
      expect(codex?.status).toBe('reclaimed');
    }
    expect(readFileSync(join(codexSkill, 'SKILL.md'), 'utf8')).toContain('v-new');
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);
  });

  test('existing SKILL.md is reclaimed with latest content', async () => {
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
      expect(claude?.status).toBe('reclaimed');
    }
    expect(readFileSync(join(claudeSkill, 'SKILL.md'), 'utf8')).toContain('v-new');
    expect(existsSync(join(projectDir, '.cursor'))).toBe(false);
  });

  test('a host whose replaceDir throws is reported failed, not crashed', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
    const claudeSkill = join(projectDir, '.claude', 'skills', 'open-knowledge');
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, 'SKILL.md'), '---\nname: open-knowledge\n---\n# v-old\n');
    const r = await reclaimProjectSkillsOnProjectOpen({
      projectDir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      deps: { resolveBundledSkillDir: () => setupBundle() },
      fs: {
        existsSync: () => true,
        isDirectory: () => false,
        readdirSync: () => [],
        readFileSync: () => Buffer.from(''),
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
      deps: { resolveBundledSkillDir: () => setupBundle() },
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') {
      expect(r.entries.every((e) => e.status === 'no-token')).toBe(true);
    }
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);
  });

  test('existing SKILL.md is refreshed (reclaimed), not re-created, even when wired', async () => {
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
      expect(r.entries.find((e) => e.editorId === 'claude')?.status).toBe('reclaimed');
    }
    expect(readFileSync(join(claudeSkill, 'SKILL.md'), 'utf8')).toContain('v-new');
  });

  test('refuses to create through a host-dir symlink escaping the project', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-proj-'));
    cleanupPaths.push(projectDir);
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
