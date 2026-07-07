import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SkillInstallEvent } from '@inkeep/open-knowledge-server';
import { EDITOR_TARGETS } from './editors.ts';
import {
  __testing,
  type RepairSkillsDeps,
  type RepairSkillsLogEvent,
  type RepairSkillsResult,
  repairSkills,
  repairSkillsCommand,
} from './repair-skills.ts';

const {
  HOSTS_WITH_USER_SKILL_DIR,
  USER_SKILL_DIR_NAME,
  PROJECT_SKILL_DIR_NAME,
  repairSkillsResultExitCode,
  formatRepairSkillsResult,
} = __testing;

function mkScratch(tag: string): { root: string; home: string; project: string; bundles: string } {
  const root = resolve(
    tmpdir(),
    `repair-skills-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const home = join(root, 'home');
  const project = join(root, 'project');
  const bundles = join(root, 'bundles');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bundles, { recursive: true });
  return { root, home, project, bundles };
}

function writeBundledSkill(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: open-knowledge\nmetadata:\n  version: "${version}"\n---\nbundled-${version}-content\n`,
  );
  writeFileSync(join(dir, 'references.md'), `bundled-${version}-references`);
}

function writeStaleSkillFiles(destDir: string, marker: string): void {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'SKILL.md'), `stale-${marker}`);
  writeFileSync(join(destDir, 'leftover.md'), `to-be-orphaned-${marker}`);
}

function depsBuilder(opts: {
  projectBundleDir: string;
  discoveryBundleDir: string;
  bundledVersion: string;
  recordedVersion: string | null;
  /** Spy: pushed-to whenever `writeRecordedVersion` is called. */
  writtenVersions: Array<{ home: string; version: string }>;
  /** Spy: pushed-to whenever `recordEvent` is called. */
  recordedEvents?: SkillInstallEvent[];
  /** When true, `writeRecordedVersion` throws. */
  failWrite?: boolean;
  /** Per-bundle opt-in decision the sweep reads. Default consented. */
  bundleDecision?: boolean | null;
  /** Spy: pushed-to whenever `removeBundleFromDisk` is called. */
  removals?: string[];
}): RepairSkillsDeps {
  return {
    resolveProjectBundledSkillDir: () => opts.projectBundleDir,
    resolveUserBundledSkillDir: () => opts.discoveryBundleDir,
    readBundledVersion: async () => opts.bundledVersion,
    readRecordedVersion: async () => opts.recordedVersion,
    writeRecordedVersion: async (home, version) => {
      opts.writtenVersions.push({ home, version });
      if (opts.failWrite) throw new Error('simulated state-write failure');
    },
    recordEvent: async (event) => {
      opts.recordedEvents?.push(event);
    },
    // Default consented so the user sweep proceeds (existing tests predate the
    // opt-in gate). Gate-specific tests override these.
    readBundleDecision: async () => opts.bundleDecision ?? true,
    writeBundleDecision: async () => {},
    removeBundleFromDisk: (_home, bundleId) => {
      opts.removals?.push(bundleId);
    },
  };
}

describe('repairSkills — project sweep (AC-A1, AC-A2, AC-A3)', () => {
  let scratch: ReturnType<typeof mkScratch>;
  let projectBundleDir: string;
  let discoveryBundleDir: string;
  let logEvents: RepairSkillsLogEvent[];

  beforeEach(() => {
    scratch = mkScratch('project');
    projectBundleDir = join(scratch.bundles, 'project');
    discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');
    logEvents = [];
  });

  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  it('AC-A1: replaces an existing SKILL.md directory with bundled content (orphans removed)', async () => {
    const claudeDest = join(scratch.project, '.claude', 'skills', PROJECT_SKILL_DIR_NAME);
    writeStaleSkillFiles(claudeDest, 'A1');

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9', // user sweep version-skips
        writtenVersions: written,
      }),
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('unreachable');
    expect(result.project.outcome).toBe('done');
    if (result.project.outcome !== 'done') throw new Error('unreachable');
    const claudeEntry = result.project.entries.find((e) => e.editorId === 'claude');
    expect(claudeEntry?.outcome).toBe('reclaimed');

    expect(readFileSync(join(claudeDest, 'SKILL.md'), 'utf-8')).toContain('bundled-9.9.9-content');
    expect(readFileSync(join(claudeDest, 'references.md'), 'utf-8')).toBe(
      'bundled-9.9.9-references',
    );
    // Orphan from the stale dir is gone — replaceDir wiped first.
    expect(existsSync(join(claudeDest, 'leftover.md'))).toBe(false);

    expect(logEvents.some((e) => e.event === 'project-skill-reclaim-reclaimed')).toBe(true);
  });

  it('AC-A2: greenfield host (no SKILL.md) reports no-token and creates nothing', async () => {
    // No SKILL.md anywhere under scratch.project. Don't pre-create dirs.
    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    for (const entry of result.project.entries) {
      expect(entry.outcome).toBe('no-token');
      expect(existsSync(entry.path)).toBe(false);
    }
    expect(logEvents.filter((e) => e.event === 'project-skill-reclaim-no-token')).toHaveLength(
      HOSTS_WITH_USER_SKILL_DIR.length,
    );
  });

  it('AC-A3: per-host write failure does not stop the other hosts', async () => {
    // Seed both .claude and .cursor with stale SKILL.md.
    const claudeDest = join(scratch.project, '.claude', 'skills', PROJECT_SKILL_DIR_NAME);
    const cursorDest = join(scratch.project, '.cursor', 'skills', PROJECT_SKILL_DIR_NAME);
    writeStaleSkillFiles(claudeDest, 'a3-claude');
    writeStaleSkillFiles(cursorDest, 'a3-cursor');

    // Break the project bundle source for one host only by injecting a deps
    // override that throws on the SECOND resolve call. Easier: use a custom
    // fs that throws when removing the claude dest specifically.
    const realFs = await import('node:fs');
    const customFs: import('./repair-skills.ts').RepairSkillsFsOps = {
      existsSync: (p) => realFs.existsSync(p),
      isDirectory: (p) => {
        try {
          return realFs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      readdirSync: (p) => realFs.readdirSync(p),
      readFileSync: (p) => realFs.readFileSync(p),
      writeFileSync: (p, c) => realFs.writeFileSync(p, c),
      mkdirSync: (p, o) => {
        realFs.mkdirSync(p, o);
      },
      rmSync: (p, o) => {
        if (p === claudeDest) {
          throw new Error('simulated rm failure on claude dest');
        }
        realFs.rmSync(p, o);
      },
    };

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      fs: customFs,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    const claude = result.project.entries.find((e) => e.editorId === 'claude');
    const cursor = result.project.entries.find((e) => e.editorId === 'cursor');
    expect(claude?.outcome).toBe('failed');
    expect(claude?.error).toContain('simulated rm failure');
    expect(cursor?.outcome).toBe('reclaimed');
    // Cursor's stale orphan got cleaned even though Claude's failed.
    expect(existsSync(join(cursorDest, 'leftover.md'))).toBe(false);
  });
});

describe('repairSkills — project sweep create-if-wired gate', () => {
  let scratch: ReturnType<typeof mkScratch>;
  let projectBundleDir: string;
  let discoveryBundleDir: string;
  let logEvents: RepairSkillsLogEvent[];

  // A `.mcp.json` carrying the `# ok-mcp-v1` chain sentinel — the wired signal.
  const OK_WIRED_MCP_JSON = JSON.stringify({
    mcpServers: {
      'open-knowledge': { command: '/bin/sh', args: ['-l', '-c', '# ok-mcp-v1\nexec ok mcp'] },
    },
  });
  const UNWIRED_MCP_JSON = JSON.stringify({ mcpServers: { other: { command: 'node' } } });
  // The Windows chain sentinel counts as wired too — an `ok start` on
  // Windows (or a shared repo initialized there) must still get skills.
  const OK_WIRED_MCP_JSON_WIN = JSON.stringify({
    mcpServers: {
      'open-knowledge': {
        command: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', '# ok-mcp-win-v1\nexit 127'],
      },
    },
  });

  beforeEach(() => {
    scratch = mkScratch('create-wired');
    projectBundleDir = join(scratch.bundles, 'project');
    discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');
    logEvents = [];
  });
  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  it('creates a project SKILL.md for a host wired for OK MCP but missing the skill', async () => {
    // Claude wired (`.mcp.json` carries the marker), no SKILL.md on disk —
    // the MCP-but-no-skill cohort. cursor/codex unwired → no-token.
    writeFileSync(join(scratch.project, '.mcp.json'), OK_WIRED_MCP_JSON);

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9', // user sweep version-skips for isolation
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    const claude = result.project.entries.find((e) => e.editorId === 'claude');
    expect(claude?.outcome).toBe('created');
    expect(result.project.entries.find((e) => e.editorId === 'cursor')?.outcome).toBe('no-token');
    expect(result.project.entries.find((e) => e.editorId === 'codex')?.outcome).toBe('no-token');

    const skillFile = join(
      scratch.project,
      '.claude',
      'skills',
      PROJECT_SKILL_DIR_NAME,
      'SKILL.md',
    );
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf-8')).toContain('bundled-9.9.9-content');
    expect(
      logEvents.some((e) => e.event === 'project-skill-reclaim-created' && e.editorId === 'claude'),
    ).toBe(true);
  });

  it('creates a project SKILL.md for a host wired with the Windows chain sentinel', async () => {
    writeFileSync(join(scratch.project, '.mcp.json'), OK_WIRED_MCP_JSON_WIN);

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    expect(result.project.entries.find((e) => e.editorId === 'claude')?.outcome).toBe('created');
    expect(
      existsSync(join(scratch.project, '.claude', 'skills', PROJECT_SKILL_DIR_NAME, 'SKILL.md')),
    ).toBe(true);
  });

  it('creates a project SKILL.md for cursor wired via .cursor/mcp.json', async () => {
    mkdirSync(join(scratch.project, '.cursor'), { recursive: true });
    writeFileSync(join(scratch.project, '.cursor', 'mcp.json'), OK_WIRED_MCP_JSON);

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    expect(result.project.entries.find((e) => e.editorId === 'cursor')?.outcome).toBe('created');
    expect(
      existsSync(join(scratch.project, '.cursor', 'skills', PROJECT_SKILL_DIR_NAME, 'SKILL.md')),
    ).toBe(true);
  });

  it('creates a project SKILL.md for codex wired via .codex/config.toml (TOML, marker substring)', async () => {
    // Codex's wired signal is TOML and its skill installs to
    // `.codex/skills/open-knowledge/` — the config-path → skill-path mapping a
    // typo could silently break. The marker is a substring of the TOML bytes.
    mkdirSync(join(scratch.project, '.codex'), { recursive: true });
    writeFileSync(
      join(scratch.project, '.codex', 'config.toml'),
      '[mcp_servers.open-knowledge]\ncommand = "/bin/sh"\nargs = ["-l", "-c", "# ok-mcp-v1\\nexec ok mcp"]\n',
    );

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    expect(result.project.entries.find((e) => e.editorId === 'codex')?.outcome).toBe('created');
    expect(
      existsSync(join(scratch.project, '.codex', 'skills', PROJECT_SKILL_DIR_NAME, 'SKILL.md')),
    ).toBe(true);
  });

  it('does NOT create when a host config exists but has no OK marker', async () => {
    writeFileSync(join(scratch.project, '.mcp.json'), UNWIRED_MCP_JSON);

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    for (const entry of result.project.entries) {
      expect(entry.outcome).toBe('no-token');
      expect(existsSync(entry.path)).toBe(false);
    }
  });

  it('refreshes (reclaimed) rather than re-creating when SKILL.md already exists and is wired', async () => {
    const claudeDest = join(scratch.project, '.claude', 'skills', PROJECT_SKILL_DIR_NAME);
    writeStaleSkillFiles(claudeDest, 'wired-refresh');
    writeFileSync(join(scratch.project, '.mcp.json'), OK_WIRED_MCP_JSON);

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    expect(result.project.entries.find((e) => e.editorId === 'claude')?.outcome).toBe('reclaimed');
    expect(readFileSync(join(claudeDest, 'SKILL.md'), 'utf-8')).toContain('bundled-9.9.9-content');
    expect(existsSync(join(claudeDest, 'leftover.md'))).toBe(false);
  });

  it('refuses to create through a host dir symlink escaping the project (create path)', async () => {
    // `.claude` symlinks outside the project; a wired `.mcp.json` makes the
    // create path eligible. The escape guard must fire before any rm/copy.
    const realFs = await import('node:fs');
    const escapeRoot = resolve(
      tmpdir(),
      `repair-skills-create-escape-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const escapeTarget = join(escapeRoot, 'evil-claude');
    mkdirSync(escapeTarget, { recursive: true });
    const witness = join(escapeTarget, 'witness.txt');
    writeFileSync(witness, 'do-not-touch');
    try {
      realFs.symlinkSync(escapeTarget, join(scratch.project, '.claude'));
      writeFileSync(join(scratch.project, '.mcp.json'), OK_WIRED_MCP_JSON);

      const written: Array<{ home: string; version: string }> = [];
      const result = await repairSkills({
        projectDir: scratch.project,
        home: scratch.home,
        logger: (event) => logEvents.push(event),
        deps: depsBuilder({
          projectBundleDir,
          discoveryBundleDir,
          bundledVersion: '9.9.9',
          recordedVersion: '9.9.9',
          writtenVersions: written,
        }),
      });

      if (result.status !== 'done' || result.project.outcome !== 'done')
        throw new Error('unreachable');
      const claude = result.project.entries.find((e) => e.editorId === 'claude');
      expect(claude?.outcome).toBe('failed');
      expect(claude?.error).toMatch(/outside the project directory/i);
      expect(readFileSync(witness, 'utf-8')).toBe('do-not-touch');
    } finally {
      rmSync(escapeRoot, { recursive: true, force: true });
    }
  });
});

describe('repairSkills — user sweep version gate (AC-B1, AC-B2, AC-B3, AC-B4)', () => {
  let scratch: ReturnType<typeof mkScratch>;
  let projectBundleDir: string;
  let discoveryBundleDir: string;
  let logEvents: RepairSkillsLogEvent[];

  beforeEach(() => {
    scratch = mkScratch('user');
    projectBundleDir = join(scratch.bundles, 'project');
    discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');
    logEvents = [];
  });

  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  it('AC-B1: skips user sweep when recorded version equals bundled version', async () => {
    // The version-current fast-path requires every ENABLED bundle already on
    // disk (a missing bundle self-heals via reinstall — parity with
    // installUserSkill). Seed both central dirs so the skip path is exercised.
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      const dir = join(scratch.home, '.agents', 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    }
    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done') throw new Error('unreachable');
    expect(result.user.outcome).toBe('skipped');
    if (result.user.outcome !== 'skipped') throw new Error('unreachable');
    expect(result.user.reason).toBe('version-current');
    expect(written).toHaveLength(0);

    // The seeded central store is left byte-untouched by the skip.
    expect(
      readFileSync(
        join(scratch.home, '.agents', 'skills', USER_SKILL_DIR_NAME, 'SKILL.md'),
        'utf-8',
      ),
    ).toBe('preexisting');

    expect(logEvents.some((e) => e.event === 'user-skill-reclaim-skipped-version-current')).toBe(
      true,
    );
  });

  it('D4/G2 cross-actor stomp: a declined bundle is removed and never re-installed by the sweep', async () => {
    // Seed both bundles on disk, then decline them. The sweep must remove them
    // and NOT re-install — the CLI half of the invariant that stops `ok start`
    // from re-adding what the desktop dialog removed.
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      const dir = join(scratch.home, '.agents', 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    }
    const written: Array<{ home: string; version: string }> = [];
    const removals: string[] = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0', // version mismatch — sweep would install if enabled
        writtenVersions: written,
        bundleDecision: false,
        removals,
      }),
    });

    if (result.status !== 'done') throw new Error('unreachable');
    expect(result.user.outcome).toBe('skipped');
    if (result.user.outcome === 'skipped') expect(result.user.reason).toBe('all-bundles-declined');
    // Both declined bundles were torn down; version not advanced.
    expect(removals.sort()).toEqual(['discovery', 'write-skill']);
    expect(written).toHaveLength(0);
  });

  it('mixed decision: the declined bundle is removed while the enabled bundle still installs', async () => {
    // Seed both on disk, then decline ONLY write-skill. discovery must install
    // (version mismatch) and write-skill must be torn down — the two gates run
    // independently per bundle.
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      const dir = join(scratch.home, '.agents', 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    }
    for (const host of ['.claude', '.cursor', '.codex']) {
      mkdirSync(join(scratch.home, host), { recursive: true });
    }
    const written: Array<{ home: string; version: string }> = [];
    const removals: string[] = [];
    const deps = depsBuilder({
      projectBundleDir,
      discoveryBundleDir,
      bundledVersion: '9.9.9',
      recordedVersion: '0.6.0',
      writtenVersions: written,
      removals,
    });
    deps.readBundleDecision = async (_home, name) => name !== 'open-knowledge-write-skill';

    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps,
    });

    if (result.status !== 'done' || result.user.outcome !== 'done') throw new Error('unreachable');
    expect(removals).toEqual(['write-skill']);
    expect(
      result.user.entries.some(
        (e) => e.kind === 'central' && (e.outcome === 'written' || e.outcome === 'overwritten'),
      ),
    ).toBe(true);
    expect(written).toHaveLength(1);
  });

  it('AC-B2: refreshes central + per-host and advances skill-state when version mismatches', async () => {
    // Seed the per-host roots so they aren't `skipped-host-absent`.
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    mkdirSync(join(scratch.home, '.cursor'), { recursive: true });
    mkdirSync(join(scratch.home, '.codex'), { recursive: true });

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.user.outcome !== 'done') throw new Error('unreachable');
    expect(result.user.version).toBe('9.9.9');

    // Central store written.
    const centralPath = join(scratch.home, '.agents', 'skills', USER_SKILL_DIR_NAME);
    expect(existsSync(join(centralPath, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(centralPath, 'SKILL.md'), 'utf-8')).toContain('bundled-9.9.9-content');

    // .claude and .cursor per-host copies written.
    const claudeDest = join(scratch.home, '.claude', 'skills', USER_SKILL_DIR_NAME);
    const cursorDest = join(scratch.home, '.cursor', 'skills', USER_SKILL_DIR_NAME);
    expect(existsSync(join(claudeDest, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cursorDest, 'SKILL.md'))).toBe(true);

    // Codex now writes its own per-host copy at `.codex` (no longer collapses
    // with the `.agents` central store).
    const codexDest = join(scratch.home, '.codex', 'skills', USER_SKILL_DIR_NAME);
    expect(existsSync(join(codexDest, 'SKILL.md'))).toBe(true);
    const codexEntry = result.user.entries.find((e) => e.kind === 'host' && e.editorId === 'codex');
    expect(codexEntry?.outcome).toBe('written');

    // State advanced.
    expect(written).toEqual([{ home: scratch.home, version: '9.9.9' }]);
  });

  it('AC-B3: treats absent skill-state.yml (recordedVersion=null) as a fresh install', async () => {
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: null,
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.user.outcome !== 'done') throw new Error('unreachable');

    const centralPath = join(scratch.home, '.agents', 'skills', USER_SKILL_DIR_NAME);
    expect(existsSync(join(centralPath, 'SKILL.md'))).toBe(true);
    expect(written).toEqual([{ home: scratch.home, version: '9.9.9' }]);
  });

  it('does NOT advance the version when central write fails but a per-host write succeeds', async () => {
    // Regression guard for a CLI-specific failure mode the Desktop doesn't
    // have. Without central-only gating, a per-host success would advance
    // skill-state.yml, and the next boot's version-current fast path would
    // permanently skip the central retry until the next CLI release.
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    const realFs = await import('node:fs');
    const customFs: import('./repair-skills.ts').RepairSkillsFsOps = {
      existsSync: (p) => realFs.existsSync(p),
      isDirectory: (p) => {
        try {
          return realFs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      readdirSync: (p) => realFs.readdirSync(p),
      readFileSync: (p) => realFs.readFileSync(p),
      writeFileSync: (p, c) => {
        // Fail only on writes whose path leads into the central store
        // (`~/.agents/skills/open-knowledge-discovery/`). Host writes
        // under `~/.claude/skills/...` succeed.
        if (p.includes('.agents/skills')) {
          throw new Error('synthetic: central path unwritable');
        }
        realFs.writeFileSync(p, c);
      },
      mkdirSync: (p, o) => {
        realFs.mkdirSync(p, o);
      },
      rmSync: (p, o) => {
        realFs.rmSync(p, o);
      },
    };

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      fs: customFs,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.user.outcome !== 'done')
      throw new Error('expected done with mixed entries');
    const central = result.user.entries.find((e) => e.kind === 'central');
    expect(central?.outcome).toBe('failed');
    const claudeHost = result.user.entries.find(
      (e) => e.kind === 'host' && e.editorId === 'claude',
    );
    expect(claudeHost?.outcome).toBe('written');
    // Critical: state must NOT advance because central failed. Next boot
    // re-runs the sweep and gets another chance to fix central.
    expect(written).toHaveLength(0);
  });

  it('treats readRecordedVersion throw (EACCES/EIO) as absent: proceeds with sweep, emits structured error event', async () => {
    // `readTargetVersion` propagates non-ENOENT errors per readSkillStateFile's
    // contract. Verify the catch logs a structured event AND falls through to
    // null so the sweep self-heals instead of aborting.
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    const written: Array<{ home: string; version: string }> = [];

    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: {
        ...depsBuilder({
          projectBundleDir,
          discoveryBundleDir,
          bundledVersion: '9.9.9',
          recordedVersion: null,
          writtenVersions: written,
        }),
        readRecordedVersion: async () => {
          throw new Error('EACCES: permission denied, open ~/.ok/skill-state.yml');
        },
      },
    });

    if (result.status !== 'done' || result.user.outcome !== 'done') throw new Error('unreachable');

    // Structured event fired with the underlying error.
    const errEvent = logEvents.find((e) => e.event === 'user-skill-reclaim-version-read-error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.error).toContain('EACCES');
    // Sweep proceeded — state advanced and central was written.
    expect(written).toEqual([{ home: scratch.home, version: '9.9.9' }]);
  });

  it('AC-B4: skips per-host writes when ~/.{host}/ root is absent (no spurious mkdir)', async () => {
    // Don't create .claude or .cursor — central still writes; per-host skips.
    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.user.outcome !== 'done') throw new Error('unreachable');

    const claudeEntry = result.user.entries.find(
      (e) => e.kind === 'host' && e.editorId === 'claude',
    );
    const cursorEntry = result.user.entries.find(
      (e) => e.kind === 'host' && e.editorId === 'cursor',
    );
    expect(claudeEntry?.outcome).toBe('skipped-host-absent');
    expect(cursorEntry?.outcome).toBe('skipped-host-absent');

    // The host roots stay absent — we don't author them.
    expect(existsSync(join(scratch.home, '.claude'))).toBe(false);
    expect(existsSync(join(scratch.home, '.cursor'))).toBe(false);

    // Central still wrote — version advanced.
    expect(written).toEqual([{ home: scratch.home, version: '9.9.9' }]);
  });

  it('reports skipped:bundle-missing when the discovery bundle dir resolve throws', async () => {
    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      logger: (event) => logEvents.push(event),
      deps: {
        resolveProjectBundledSkillDir: () => projectBundleDir,
        resolveUserBundledSkillDir: () => {
          throw new Error('synthetic: discovery bundle not found');
        },
        readBundledVersion: async () => '9.9.9',
        readRecordedVersion: async () => '0.6.0',
        writeRecordedVersion: async (home, version) => {
          written.push({ home, version });
        },
      },
    });

    if (result.status !== 'done' || result.user.outcome !== 'skipped')
      throw new Error('expected skipped: bundle-missing');
    expect(result.user.reason).toBe('bundle-missing');
    expect(written).toHaveLength(0);
    expect(logEvents.some((e) => e.event === 'user-skill-reclaim-bundle-missing')).toBe(true);
  });

  it('does NOT advance the version when every per-host AND central write failed', async () => {
    // Bundle dir exists but every replaceDir call throws — verifies the
    // anyWriteSucceeded gate doesn't advance state on a fully-failed sweep.
    const realFs = await import('node:fs');
    const customFs: import('./repair-skills.ts').RepairSkillsFsOps = {
      existsSync: (p) => realFs.existsSync(p),
      isDirectory: (p) => {
        try {
          return realFs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      readdirSync: (p) => realFs.readdirSync(p),
      readFileSync: (p) => realFs.readFileSync(p),
      writeFileSync: () => {
        throw new Error('synthetic: every write fails');
      },
      mkdirSync: (p, o) => {
        realFs.mkdirSync(p, o);
      },
      rmSync: (p, o) => {
        realFs.rmSync(p, o);
      },
    };

    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    mkdirSync(join(scratch.home, '.cursor'), { recursive: true });

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      fs: customFs,
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.user.outcome !== 'done')
      throw new Error('expected done with all-failed entries');
    const failedEntries = result.user.entries.filter((e) => e.outcome === 'failed');
    expect(failedEntries.length).toBeGreaterThan(0);
    // Critical assertion: state file write must NOT be triggered.
    expect(written).toHaveLength(0);
  });
});

describe('repairSkills — OK_RECLAIM_DISABLE env gate (AC-C1)', () => {
  let scratch: ReturnType<typeof mkScratch>;

  beforeEach(() => {
    scratch = mkScratch('disable');
  });
  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  it('returns skipped with reason=reclaim-disabled and touches nothing', async () => {
    const projectBundleDir = join(scratch.bundles, 'project');
    const discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');

    // Seed a stale on-disk SKILL.md that WOULD be rewritten if the gate failed.
    const claudeDest = join(scratch.project, '.claude', 'skills', PROJECT_SKILL_DIR_NAME);
    writeStaleSkillFiles(claudeDest, 'C1-stale');

    const logEvents: RepairSkillsLogEvent[] = [];
    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      reclaimDisableEnv: '1',
      logger: (event) => logEvents.push(event),
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
      }),
    });

    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') throw new Error('unreachable');
    expect(result.reason).toBe('reclaim-disabled');

    // Stale content untouched.
    expect(readFileSync(join(claudeDest, 'SKILL.md'), 'utf-8')).toBe('stale-C1-stale');
    expect(existsSync(join(claudeDest, 'leftover.md'))).toBe(true);

    // Central store NOT created.
    expect(existsSync(join(scratch.home, '.agents', 'skills', USER_SKILL_DIR_NAME))).toBe(false);

    // Single skip event, no fan-out events. Event name shares the
    // `*-repair-skipped` prefix used by the sibling sweeps.
    expect(logEvents).toEqual([{ event: 'skill-repair-skipped', reason: 'reclaim-disabled' }]);
    expect(written).toHaveLength(0);
  });

  it('treats reclaimDisableEnv values other than literal "1" as not-disabled', async () => {
    const projectBundleDir = join(scratch.bundles, 'project');
    const discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');

    const written: Array<{ home: string; version: string }> = [];
    for (const env of ['0', 'true', '', null, undefined]) {
      const result = await repairSkills({
        projectDir: scratch.project,
        home: scratch.home,
        reclaimDisableEnv: env as string | null | undefined,
        deps: depsBuilder({
          projectBundleDir,
          discoveryBundleDir,
          bundledVersion: '9.9.9',
          recordedVersion: '9.9.9', // version-skip user sweep to keep this tight
          writtenVersions: written,
        }),
      });
      expect(result.status).toBe('done');
    }
  });
});

describe('coverage meta-test (AC-D2): HOSTS_WITH_USER_SKILL_DIR ↔ EDITOR_TARGETS.projectSkillPath', () => {
  it('CLI host list matches the set of editor ids that declare a projectSkillPath', () => {
    const hostsWithProjectSkillPath = Object.entries(EDITOR_TARGETS)
      .filter(([, target]) => target.projectSkillPath !== undefined)
      .map(([id]) => id)
      .sort();

    const hostsInReclaim = HOSTS_WITH_USER_SKILL_DIR.map((h) => h.editorId).sort();

    expect(hostsInReclaim).toEqual(hostsWithProjectSkillPath);
  });
});

describe('repairSkills — JSONL telemetry parity with Desktop', () => {
  let scratch: ReturnType<typeof mkScratch>;
  let projectBundleDir: string;
  let discoveryBundleDir: string;

  beforeEach(() => {
    scratch = mkScratch('jsonl');
    projectBundleDir = join(scratch.bundles, 'project');
    discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');
  });
  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  it('emits surface=cli-start outcome=installed when user sweep advances the version', async () => {
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
        recordedEvents,
      }),
    });

    const installed = recordedEvents.find((e) => e.outcome === 'installed');
    expect(installed).toBeDefined();
    expect(installed?.surface).toBe('cli-start');
    expect(installed?.target).toBe('cli-hosts');
    expect(installed?.bundle).toBe('discovery');
    expect(installed?.version).toBe('9.9.9');
  });

  it('emits outcome=failed with reason=state-write-failed when writeRecordedVersion throws', async () => {
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
        recordedEvents,
        failWrite: true,
      }),
    });

    const failedEvent = recordedEvents.find((e) => e.outcome === 'failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.surface).toBe('cli-start');
    expect(failedEvent?.reason).toContain('state-write-failed');
  });

  it('emits outcome=failed with reason=bundle-missing when the discovery resolver throws', async () => {
    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: {
        resolveProjectBundledSkillDir: () => projectBundleDir,
        resolveUserBundledSkillDir: () => {
          throw new Error('synthetic: discovery bundle not found');
        },
        readBundledVersion: async () => '9.9.9',
        readRecordedVersion: async () => '0.6.0',
        writeRecordedVersion: async (home, version) => {
          written.push({ home, version });
        },
        recordEvent: async (event) => {
          recordedEvents.push(event);
        },
      },
    });

    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]?.surface).toBe('cli-start');
    expect(recordedEvents[0]?.outcome).toBe('failed');
    expect(recordedEvents[0]?.reason).toContain('bundle-missing');
  });

  it('emits outcome=failed with reason=version-read-failed when readBundledVersion throws', async () => {
    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: {
        resolveProjectBundledSkillDir: () => projectBundleDir,
        resolveUserBundledSkillDir: () => discoveryBundleDir,
        readBundledVersion: async () => {
          throw new Error('synthetic: cannot read package.json');
        },
        readRecordedVersion: async () => null,
        writeRecordedVersion: async (home, version) => {
          written.push({ home, version });
        },
        recordEvent: async (event) => {
          recordedEvents.push(event);
        },
      },
    });

    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]?.outcome).toBe('failed');
    expect(recordedEvents[0]?.reason).toContain('version-read-failed');
  });

  it('emits NO event on the version-current fast-path', async () => {
    // Seed both enabled bundles on disk so the version-current fast-path fires
    // (a missing bundle self-heals via reinstall, which would emit events).
    for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
      const dir = join(scratch.home, '.agents', 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'preexisting');
    }
    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9',
        writtenVersions: written,
        recordedEvents,
      }),
    });

    expect(recordedEvents).toHaveLength(0);
  });

  it('emits outcome=failed reason=no-hosts-installed when central fails AND no per-host dirs exist', async () => {
    // Strictly synthetic existsSync — only paths we name as "present" return
    // true. Lets the test assert "no host dirs visible" deterministically
    // without depending on what the central-write side effects leave on disk.
    const realFs = await import('node:fs');
    const presentPaths = new Set<string>();
    const customFs: import('./repair-skills.ts').RepairSkillsFsOps = {
      existsSync: (p) => presentPaths.has(p),
      isDirectory: (p) => {
        try {
          return realFs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      readdirSync: (p) => realFs.readdirSync(p),
      readFileSync: (p) => realFs.readFileSync(p),
      writeFileSync: () => {
        throw new Error('synthetic: every write fails');
      },
      mkdirSync: () => {
        /* no-op — we don't need real dirs because writeFileSync throws first */
      },
      rmSync: () => {
        /* no-op */
      },
    };

    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      fs: customFs,
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
        recordedEvents,
      }),
    });

    // No host dirs are present, so every host (claude, cursor, codex) hits
    // skipped-host-absent. The only failure is the central write itself, so
    // `no-hosts-installed` is the precise reason.
    expect(presentPaths.size).toBe(0); // sanity: no host dirs marked present
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]?.outcome).toBe('failed');
    expect(recordedEvents[0]?.reason).toBe('no-hosts-installed');
  });

  it('emits outcome=failed reason=all-writes-failed when central AND per-host writes all throw', async () => {
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    mkdirSync(join(scratch.home, '.cursor'), { recursive: true });
    const realFs = await import('node:fs');
    const customFs: import('./repair-skills.ts').RepairSkillsFsOps = {
      existsSync: (p) => realFs.existsSync(p),
      isDirectory: (p) => {
        try {
          return realFs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      readdirSync: (p) => realFs.readdirSync(p),
      readFileSync: (p) => realFs.readFileSync(p),
      writeFileSync: () => {
        throw new Error('synthetic: every write fails');
      },
      mkdirSync: (p, o) => {
        realFs.mkdirSync(p, o);
      },
      rmSync: (p, o) => {
        realFs.rmSync(p, o);
      },
    };

    const written: Array<{ home: string; version: string }> = [];
    const recordedEvents: SkillInstallEvent[] = [];

    await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      fs: customFs,
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '0.6.0',
        writtenVersions: written,
        recordedEvents,
      }),
    });

    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]?.outcome).toBe('failed');
    expect(recordedEvents[0]?.reason).toBe('all-writes-failed');
  });

  it('JSONL emission failures never propagate (telemetry must not affect install outcomes)', async () => {
    mkdirSync(join(scratch.home, '.claude'), { recursive: true });
    const written: Array<{ home: string; version: string }> = [];

    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: {
        resolveProjectBundledSkillDir: () => projectBundleDir,
        resolveUserBundledSkillDir: () => discoveryBundleDir,
        readBundledVersion: async () => '9.9.9',
        readRecordedVersion: async () => '0.6.0',
        writeRecordedVersion: async (home, version) => {
          written.push({ home, version });
        },
        recordEvent: async () => {
          throw new Error('synthetic telemetry failure');
        },
        readBundleDecision: async () => true,
      },
    });

    // Outcome is unaffected by the swallowed telemetry exception.
    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('unreachable');
    expect(result.user.outcome).toBe('done');
    expect(written).toHaveLength(1);
  });
});

describe('formatRepairSkillsResult — done-branch stdout formatting', () => {
  it('renders per-sweep counts when both sweeps ran to done', () => {
    const out = formatRepairSkillsResult({
      status: 'done',
      project: {
        outcome: 'done',
        entries: [
          { editorId: 'claude', hostDir: '.claude', path: '/x', outcome: 'reclaimed' },
          { editorId: 'cursor', hostDir: '.cursor', path: '/y', outcome: 'no-token' },
          {
            editorId: 'codex',
            hostDir: '.codex',
            path: '/z',
            outcome: 'failed',
            error: 'simulated',
          },
        ],
      },
      user: {
        outcome: 'done',
        version: '9.9.9',
        entries: [
          { kind: 'central', path: '/h', outcome: 'written' },
          {
            kind: 'host',
            editorId: 'claude',
            hostDir: '.claude',
            path: '/c',
            outcome: 'overwritten',
          },
          {
            kind: 'host',
            editorId: 'cursor',
            hostDir: '.cursor',
            path: '/u',
            outcome: 'skipped-host-absent',
          },
          {
            kind: 'host',
            editorId: 'codex',
            hostDir: '.codex',
            path: '/g',
            outcome: 'skipped-host-absent',
          },
        ],
      },
    });
    expect(out).toContain('Skill reclaim complete.');
    expect(out).toContain('Project: 1 reclaimed, 0 created, 1 no-token, 1 failed.');
    expect(out).toContain('User (9.9.9): 2 written, 2 skipped, 0 failed.');
  });

  it('renders skip reason when the user sweep version-skips', () => {
    const out = formatRepairSkillsResult({
      status: 'done',
      project: { outcome: 'done', entries: [] },
      user: { outcome: 'skipped', reason: 'version-current' },
    });
    expect(out).toContain('User: skipped (version-current).');
  });

  it('renders top-level skip reason when the whole sweep short-circuits', () => {
    const out = formatRepairSkillsResult({ status: 'skipped', reason: 'reclaim-disabled' });
    expect(out).toBe('Skipped: reclaim-disabled');
  });
});

describe('repairSkillsResultExitCode (PR feedback: standalone exit code mapping)', () => {
  function mkDone(opts: {
    projectFailed?: boolean;
    userFailedHost?: boolean;
    userSkipped?:
      | 'version-current'
      | 'bundle-missing'
      | 'version-read-failed'
      | 'all-bundles-declined';
  }): RepairSkillsResult {
    const project: RepairSkillsResult extends infer R
      ? R extends { project: infer P }
        ? P
        : never
      : never = {
      outcome: 'done',
      entries: [
        {
          editorId: 'claude',
          hostDir: '.claude',
          path: '/tmp/x',
          outcome: opts.projectFailed ? 'failed' : 'reclaimed',
          ...(opts.projectFailed ? { error: 'simulated' } : {}),
        },
      ],
    };
    const user: RepairSkillsResult extends infer R
      ? R extends { user: infer U }
        ? U
        : never
      : never = opts.userSkipped
      ? { outcome: 'skipped', reason: opts.userSkipped }
      : {
          outcome: 'done',
          version: '9.9.9',
          entries: opts.userFailedHost
            ? [{ kind: 'central', path: '/tmp/x', outcome: 'failed', error: 'simulated' }]
            : [{ kind: 'central', path: '/tmp/x', outcome: 'written' }],
        };
    return { status: 'done', project, user };
  }

  it('reclaim-disabled skip exits 0', () => {
    expect(repairSkillsResultExitCode({ status: 'skipped', reason: 'reclaim-disabled' })).toBe(0);
  });

  it('all-bundles-declined user-sweep skip exits 0 (intentional opt-out, not a failure)', () => {
    // The real shape: runUserSweep returns it as result.user.reason with a
    // top-level status of 'done' — NOT a top-level skip.
    const result = mkDone({ userSkipped: 'all-bundles-declined' });
    expect(result.status).toBe('done');
    expect(repairSkillsResultExitCode(result)).toBe(0);
  });

  it('any other top-level skip exits 1', () => {
    expect(repairSkillsResultExitCode({ status: 'skipped', reason: 'something-else' })).toBe(1);
  });

  it('done with all-success exits 0', () => {
    expect(repairSkillsResultExitCode(mkDone({}))).toBe(0);
  });

  it('done with version-current user-skip still exits 0 (success path)', () => {
    expect(repairSkillsResultExitCode(mkDone({ userSkipped: 'version-current' }))).toBe(0);
  });

  it('done with bundle-missing user-skip exits 1', () => {
    expect(repairSkillsResultExitCode(mkDone({ userSkipped: 'bundle-missing' }))).toBe(1);
  });

  it('done with any project failure exits 1', () => {
    expect(repairSkillsResultExitCode(mkDone({ projectFailed: true }))).toBe(1);
  });

  it('done with any user-sweep failure exits 1', () => {
    expect(repairSkillsResultExitCode(mkDone({ userFailedHost: true }))).toBe(1);
  });
});

describe('repairSkillsCommand — Commander action wiring (AC-D1, AC-D3)', () => {
  let scratch: ReturnType<typeof mkScratch>;
  let prevReclaim: string | undefined;
  let prevExitCode: number | undefined | string;

  beforeEach(() => {
    scratch = mkScratch('cmd');
    prevReclaim = process.env.OK_RECLAIM_DISABLE;
    prevExitCode = process.exitCode;
  });
  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
    if (prevReclaim === undefined) delete process.env.OK_RECLAIM_DISABLE;
    else process.env.OK_RECLAIM_DISABLE = prevReclaim;
    process.exitCode = prevExitCode as number | undefined;
  });

  it('AC-D1: command resolves projectDir from process.cwd() and writes a result summary to stdout', async () => {
    // Empty project dir — every host hits no-token.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    const origCwd = process.cwd();
    try {
      process.chdir(scratch.project);
      // Force OK_RECLAIM_DISABLE to skip the user-sweep IO path against real $HOME.
      process.env.OK_RECLAIM_DISABLE = '1';
      const cmd = repairSkillsCommand();
      await cmd.parseAsync(['node', 'repair-skills']);
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    const combined = writes.join('');
    expect(combined).toContain('Skipped: reclaim-disabled');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('AC-D3: command honors program-level chdir (program `--cwd` is the canonical surface)', async () => {
    process.env.OK_RECLAIM_DISABLE = '1';
    const origCwd = process.cwd();
    try {
      // Mirrors what the program-level `--cwd` preAction does: chdir before
      // the subcommand action runs, then `process.cwd()` resolves the right
      // projectDir. Single source of truth for cwd selection across the CLI.
      process.chdir(scratch.project);
      const cmd = repairSkillsCommand();
      await cmd.parseAsync(['node', 'repair-skills']);
    } finally {
      process.chdir(origCwd);
    }
    // No exception, exit code clean. The substantive behavior is covered by
    // the unit tests above — this asserts only the wiring seam.
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('repairSkills — symlink-escape guard (parity with writeProjectSkill)', () => {
  let scratch: ReturnType<typeof mkScratch>;
  let projectBundleDir: string;
  let discoveryBundleDir: string;
  let escapeRoot: string;

  beforeEach(() => {
    scratch = mkScratch('symlink');
    projectBundleDir = join(scratch.bundles, 'project');
    discoveryBundleDir = join(scratch.bundles, 'discovery');
    writeBundledSkill(projectBundleDir, '9.9.9');
    writeBundledSkill(discoveryBundleDir, '9.9.9');
    // Distinct tmpdir that lives OUTSIDE the project so a symlink pointing
    // at it triggers the escape guard.
    escapeRoot = resolve(
      tmpdir(),
      `repair-skills-escape-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(escapeRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
    rmSync(escapeRoot, { recursive: true, force: true });
  });

  it('refuses to rewrite when a host dir is a symlink escaping the project root', async () => {
    // Plant `.claude` as a symlink to a directory outside the project, and
    // pre-create a SKILL.md inside that escape target so the no-create gate
    // is satisfied (this is the bait an attacker would set).
    const realFs = await import('node:fs');
    const escapeTarget = join(escapeRoot, 'evil-claude');
    mkdirSync(join(escapeTarget, 'skills', PROJECT_SKILL_DIR_NAME), { recursive: true });
    writeFileSync(join(escapeTarget, 'skills', PROJECT_SKILL_DIR_NAME, 'SKILL.md'), 'bait');

    realFs.symlinkSync(escapeTarget, join(scratch.project, '.claude'));

    const witnessFile = join(escapeTarget, 'witness.txt');
    writeFileSync(witnessFile, 'should-not-be-touched');

    const written: Array<{ home: string; version: string }> = [];
    const result = await repairSkills({
      projectDir: scratch.project,
      home: scratch.home,
      deps: depsBuilder({
        projectBundleDir,
        discoveryBundleDir,
        bundledVersion: '9.9.9',
        recordedVersion: '9.9.9', // user sweep version-skips for isolation
        writtenVersions: written,
      }),
    });

    if (result.status !== 'done' || result.project.outcome !== 'done')
      throw new Error('unreachable');
    const claude = result.project.entries.find((e) => e.editorId === 'claude');
    expect(claude?.outcome).toBe('failed');
    expect(claude?.error).toMatch(/outside the project directory/i);
    // The escape target's contents are untouched — guard fired BEFORE any rm.
    expect(existsSync(witnessFile)).toBe(true);
  });
});
