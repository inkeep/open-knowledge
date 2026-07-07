import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readBundleDecision } from '@inkeep/open-knowledge-server';
import { loadConfig } from '../config/loader.ts';
import { OK_DIR } from '../constants.ts';
import { previewContent } from '../content/preview.ts';
import {
  ALL_EDITOR_IDS,
  CHAIN_V1,
  EDITOR_TARGETS,
  resolveClaudeCodeConfigPath,
  resolveClaudeDesktopConfigPath,
  resolveCodexConfigPath,
  resolveCursorConfigPath,
  resolveOpenCodeConfigPath,
} from './editors.ts';

const PUBLISHED_CHAIN_ENTRY = { command: '/bin/sh', args: ['-l', '-c', CHAIN_V1] } as const;

import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../native/toml-config-engine.ts';
// `parseEditorFlag` removed along with the `--editors`
// CLI flag — `ok init` now installs for a canonical default set instead of
// user-specified subsets. `writeUserMcpConfigs` exports are
// additions that survive.
import {
  applySharingMode,
  buildInitJsonSummary,
  ContentDirError,
  classifyExistingMcpEntry,
  detectInstalledEditors,
  type EditorMcpResult,
  formatInitResult,
  formatSharingOutcome,
  initCommand,
  LAUNCH_UI_CHAIN_SENTINEL,
  LAUNCH_UI_CHAIN_V1,
  readExistingMcpEntry,
  resolveInitSkillEnablement,
  resolveMcpScope,
  resolveRequestedContentDir,
  resolveSharingMode,
  runInit,
  writeEditorMcpConfig,
  writeUserMcpConfigs,
} from './init.ts';
import { LAUNCH_JSON_PORT } from './ui.ts';

// The native TOML addon is absent when its napi `.node` wasn't built (a turbo cache
// miss, or local dev without a build) — the engine then falls back to smol-toml. A
// few tests below assert NATIVE-specific outcomes (a valid i64 config classified
// `no-entry`, a format-preserving write) that only hold with the native backend;
// skip them when it is unavailable (the CI test cell force-builds it) so a fallback
// host doesn't red them. The fallback dispositions are covered separately by the
// forced `() => null` engine tests.
const NATIVE_TOML_AVAILABLE = createTomlConfigEngine().backend === 'native';

describe('LAUNCH_UI_CHAIN_V1 (published launch.json recipe shell chain)', () => {
  it('is syntactically valid POSIX sh (sh -n)', () => {
    // The recipe runs on every user machine after `ok init` / desktop reclaim,
    // so a shell syntax error would silently break the preview everywhere.
    // `sh -n` parses without executing — hermetic, ~ms.
    const result = spawnSync('sh', ['-n', '-c', LAUNCH_UI_CHAIN_V1], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  // The argv-forwarding tests below EXECUTE the chain via `/bin/sh -l -c`. The
  // recipe is macOS-only (it resolves an `OpenKnowledge.app` bundle), and the
  // execution semantics depend on the macOS `/bin/sh` (bash). On a Linux CI
  // runner `/bin/sh` is dash and the bundle-probe path differs, so the chain
  // falls through to its `npx @latest` network branch and the assertion is
  // meaningless. Gate execution on darwin (dev macs + macOS CI lanes); the
  // platform-agnostic `sh -n` syntax check above still runs everywhere.
  const itDarwin = it.skipIf(process.platform !== 'darwin');

  // Stub the user-bundle resolution target ($HOME/Applications/.../ok.sh) with a
  // script that echoes its argv, so the chain's FIRST exec branch fires and we
  // can observe exactly what it forwards. Returns the stubbed HOME.
  function withStubbedBundle(): { home: string; cleanup: () => void } {
    const home = join(tmpdir(), `ok-ui-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const binDir = join(
      home,
      'Applications',
      'OpenKnowledge.app',
      'Contents',
      'Resources',
      'cli',
      'bin',
    );
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'ok.sh');
    writeFileSync(stub, '#!/bin/sh\necho "STUB:$*"\n');
    spawnSync('chmod', ['+x', stub]);
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  itDarwin('forwards the pane PORT as `start --ui-port <PORT>`', () => {
    const { home, cleanup } = withStubbedBundle();
    try {
      const out = spawnSync('sh', ['-l', '-c', LAUNCH_UI_CHAIN_V1], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, PORT: '40123' },
      });
      expect(out.stdout.trim()).toBe('STUB:start --ui-port 40123');
    } finally {
      cleanup();
    }
  });

  itDarwin(
    'defaults --ui-port to LAUNCH_JSON_PORT when PORT is unset (main stays connect-armed)',
    () => {
      const { home, cleanup } = withStubbedBundle();
      try {
        const env = { ...process.env, HOME: home };
        delete (env as { PORT?: string }).PORT;
        const out = spawnSync('sh', ['-l', '-c', LAUNCH_UI_CHAIN_V1], { encoding: 'utf-8', env });
        expect(out.stdout.trim()).toBe(`STUB:start --ui-port ${LAUNCH_JSON_PORT}`);
      } finally {
        cleanup();
      }
    },
  );
});

describe('runInit', () => {
  let testDir: string;
  let fakeHome: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  // OpenCode resolves its user-global config under $XDG_CONFIG_HOME (default
  // ~/.config). Neutralize the ambient var so user-scope path resolution is
  // deterministic against the stubbed HOME on every host (incl. Linux CI).
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalArgv1 = process.argv[1];

  const claudeConfigPath = () => resolveClaudeCodeConfigPath({ home: fakeHome });
  const cursorConfigPath = () => resolveCursorConfigPath({ home: fakeHome });
  const codexConfigPath = () => resolveCodexConfigPath({ home: fakeHome, env: {} });
  const opencodeConfigPath = () => resolveOpenCodeConfigPath({ home: fakeHome, env: {} });
  const devRepoRoot = () => join(testDir, 'local-open-knowledge');
  // `--dev-mcp` resolves the worktree's `dist/cli.mjs` from `process.argv[1]`.
  // Tests stub argv[1] via `enableDevMcp()` so resolution lands at a
  // deterministic path inside `testDir` regardless of the host's bun-test argv.
  const devCliEntryPath = () => join(devRepoRoot(), 'packages', 'cli', 'src', 'cli.ts');
  const enableDevMcp = () => {
    process.argv[1] = devCliEntryPath();
  };
  const expectedDevMcpEntry = () => ({
    command: 'node',
    args: [join(devRepoRoot(), 'packages', 'cli', 'dist', 'cli.mjs'), 'mcp'],
    env: {
      MCP_DEBUG: '1',
      OK_LOG_FILE: '/tmp/ok-mcp.log',
    },
  });
  // The recipe is now a `# ok-ui-v1` `/bin/sh` chain running `ok start` (not
  // bare `ok ui`) so the opened folder gets its own collab server. Assert the
  // chain shape rather than a brittle byte-for-byte string. Dev mode pins the
  // chain's `exec` to the local CLI dist (`dist/cli.mjs`).
  const assertChainEntry = (
    entry: {
      name: string;
      runtimeExecutable: string;
      runtimeArgs: string[];
      port: number;
      autoPort: boolean;
    },
    opts: { devDist?: string } = {},
  ) => {
    expect(entry.name).toBe('open-knowledge-ui');
    expect(entry.runtimeExecutable).toBe('/bin/sh');
    expect(entry.runtimeArgs.slice(0, 2)).toEqual(['-l', '-c']);
    const chain = entry.runtimeArgs[2];
    expect(chain).toContain(LAUNCH_UI_CHAIN_SENTINEL);
    expect(chain).toContain('start');
    expect(chain).toContain('--ui-port');
    if (opts.devDist !== undefined) {
      expect(chain).toContain(`exec node "${opts.devDist}" start`);
    }
    expect(entry.port).toBe(LAUNCH_JSON_PORT);
    expect(entry.autoPort).toBe(true);
  };
  const devDistPath = () => join(devRepoRoot(), 'packages', 'cli', 'dist', 'cli.mjs');
  /**
   * Stubbed installUserSkill used by every test unless overridden. Prevents
   * the real `npx skills` subprocess from firing in the test suite, keeping
   * runs hermetic + fast.
   */
  const defaultInstallUserSkill = async () => 'installed' as const;
  const runInitForTest = async (options: Parameters<typeof runInit>[0] = {}) =>
    runInit({
      cwd: testDir,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      // Default to user scope so existing tests remain focused on user-scope
      // behavior. New scope tests set scope explicitly.
      scope: 'user',
      ...options,
    });

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `init-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    process.argv[1] = originalArgv1;
    rmSync(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Original tests — backward compat (default editors: ['claude'])
  // -----------------------------------------------------------------------

  it('scaffolds .ok/ and writes a fresh global Claude config', async () => {
    const result = await runInitForTest();

    expect(result.contentCreated.length).toBeGreaterThan(0);
    // scaffold: config-only, no content subdirs.
    // the internal .ok/AGENTS.md
    // README is no longer scaffolded.
    // Runtime subdirs (.ok/local/, .ok/local/cache/, .ok/local/tmp/) are
    // created lazily by writers — not part of the scaffold.
    expect(existsSync(join(testDir, OK_DIR, 'cache'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'local'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
    expect(existsSync(join(testDir, OK_DIR, 'articles'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'external-sources'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'research'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codeium'))).toBe(false);

    // Backward-compat fields
    expect(result.mcpAction).toBe('written');
    const mcpPath = claudeConfigPath();
    expect(existsSync(mcpPath)).toBe(true);

    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers[result.editors[0].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);

    // New editors array
    expect(result.editors).toHaveLength(1);
    expect(result.editors[0].editorId).toBe('claude');
    expect(result.editors[0].action).toBe('written');
  });

  it('preserves other mcpServers entries when adding open-knowledge', async () => {
    writeFileSync(
      claudeConfigPath(),
      JSON.stringify(
        {
          mcpServers: {
            someOtherServer: {
              command: 'node',
              args: ['./other.js'],
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await runInitForTest();
    expect(result.mcpAction).toBe('written');

    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'));
    expect(config.mcpServers.someOtherServer).toEqual({
      command: 'node',
      args: ['./other.js'],
    });
    expect(config.mcpServers[result.editors[0].serverName]).toBeDefined();
  });

  it('writes a local dev MCP entry when --dev-mcp is enabled', async () => {
    enableDevMcp();
    const result = await runInitForTest({ devMcp: true });

    expect(result.mcpAction).toBe('written');

    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'));
    expect(config.mcpServers[result.editors[0].serverName]).toEqual(expectedDevMcpEntry());
  });

  it('overwrites a differing open-knowledge entry by default', async () => {
    writeFileSync(
      claudeConfigPath(),
      JSON.stringify(
        {
          mcpServers: {
            'open-knowledge': {
              command: 'node',
              args: ['./packages/cli/dist/cli.mjs', 'mcp'],
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await runInitForTest();
    expect(result.mcpAction).toBe('overwritten');
    expect(result.editors[0].action).toBe('overwritten');

    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'));
    expect(config.mcpServers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('replaces user-added fields instead of merging them', async () => {
    writeFileSync(
      claudeConfigPath(),
      JSON.stringify(
        {
          mcpServers: {
            'open-knowledge': {
              command: 'npx',
              args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'],
              cwd: testDir,
              env: { OK_MODE: 'local' },
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await runInitForTest();
    expect(result.mcpAction).toBe('overwritten');
    expect(result.editors[0].action).toBe('overwritten');

    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'));
    expect(config.mcpServers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('overwrites a published MCP entry in dev mode', async () => {
    writeFileSync(
      claudeConfigPath(),
      JSON.stringify(
        {
          mcpServers: {
            'open-knowledge': {
              command: 'npx',
              args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'],
            },
          },
        },
        null,
        2,
      ),
    );

    enableDevMcp();
    const result = await runInitForTest({ devMcp: true });
    expect(result.mcpAction).toBe('overwritten');
    expect(result.editors[0].action).toBe('overwritten');

    const config = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'));
    expect(config.mcpServers['open-knowledge']).toEqual(expectedDevMcpEntry());
  });

  it('does not touch ~/.claude.json when --no-mcp is passed', async () => {
    const result = await runInitForTest({ mcp: false });

    expect(result.mcpAction).toBe('skipped-flag');
    expect(existsSync(claudeConfigPath())).toBe(false);

    // But the .ok/ config scaffold IS created
    expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
  });

  it('is idempotent — running twice produces the same end state', async () => {
    const firstResult = await runInitForTest();
    expect(firstResult.mcpAction).toBe('written');
    expect(firstResult.contentCreated.length).toBeGreaterThan(0);

    const firstConfig = readFileSync(claudeConfigPath(), 'utf-8');

    const secondResult = await runInitForTest();
    expect(secondResult.mcpAction).toBe('overwritten');
    expect(secondResult.contentCreated.length).toBe(0);
    expect(secondResult.contentSkipped.length).toBeGreaterThan(0);

    const secondConfig = readFileSync(claudeConfigPath(), 'utf-8');
    expect(secondConfig).toBe(firstConfig);
  });

  it('declines and leaves ~/.claude.json byte-unchanged when it is invalid JSON', async () => {
    const original = '{not valid json';
    writeFileSync(claudeConfigPath(), original);

    const result = await runInitForTest();
    // Guest-ownership: a present config OK cannot parse is left untouched, not
    // reset or reported as a failure (which would exit non-zero on `ok init`).
    expect(result.mcpAction).toBe('declined');
    expect(result.editors[0].action).toBe('declined');
    expect(result.editors[0].declineReason).toBe('unparseable');
    expect(readFileSync(claudeConfigPath(), 'utf-8')).toBe(original);

    // The decline renders as a bounded "left unchanged" line in the summary —
    // never a failure or a silent success.
    const output = formatInitResult(result, testDir);
    expect(output).toContain('left unchanged (config not readable)');

    // Config scaffold should still have been created
    expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multi-editor tests
  // -----------------------------------------------------------------------

  describe('Cursor', () => {
    it('writes ~/.cursor/mcp.json with mcpServers key', async () => {
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      const result = await runInitForTest({ editors: ['cursor'] });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('cursor');
      expect(result.editors[0].action).toBe('written');

      const configPath = cursorConfigPath();
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcpServers[result.editors[0].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('preserves existing Cursor MCP entries', async () => {
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      writeFileSync(
        cursorConfigPath(),
        JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x'] } } }, null, 2),
      );

      const result = await runInitForTest({ editors: ['cursor'] });
      expect(result.editors[0].action).toBe('written');

      const config = JSON.parse(readFileSync(cursorConfigPath(), 'utf-8'));
      expect(config.mcpServers.other).toEqual({ command: 'node', args: ['x'] });
      expect(config.mcpServers[result.editors[0].serverName]).toBeDefined();
    });
  });

  describe('Codex', () => {
    it('writes ~/.codex/config.toml with mcp_servers key', async () => {
      mkdirSync(dirname(codexConfigPath()), { recursive: true });
      const result = await runInitForTest({ editors: ['codex'] });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('codex');
      expect(result.editors[0].action).toBe('written');

      const configPath = codexConfigPath();
      expect(existsSync(configPath)).toBe(true);

      const config = Bun.TOML.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcp_servers).toBeDefined();
      expect(config.mcp_servers[result.editors[0].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('writes the dev MCP env block to Codex TOML configs', async () => {
      mkdirSync(dirname(codexConfigPath()), { recursive: true });
      enableDevMcp();
      const result = await runInitForTest({
        editors: ['codex'],
        devMcp: true,
      });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].action).toBe('written');

      const config = Bun.TOML.parse(readFileSync(codexConfigPath(), 'utf-8'));
      expect(config.mcp_servers[result.editors[0].serverName]).toEqual(expectedDevMcpEntry());
    });

    it.skipIf(!NATIVE_TOML_AVAILABLE)('preserves existing Codex MCP entries', async () => {
      mkdirSync(dirname(codexConfigPath()), { recursive: true });
      writeFileSync(
        codexConfigPath(),
        ['[mcp_servers.other]', 'command = "node"', 'args = ["x"]', ''].join('\n'),
      );

      const result = await runInitForTest({ editors: ['codex'] });
      expect(result.editors[0].action).toBe('written');

      const config = Bun.TOML.parse(readFileSync(codexConfigPath(), 'utf-8'));
      expect(config.mcp_servers.other).toEqual({ command: 'node', args: ['x'] });
      expect(config.mcp_servers[result.editors[0].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);
    });
  });

  describe('OpenCode', () => {
    // OpenCode keys MCP servers under `mcp` (not `mcpServers`) and wraps each
    // server in a `{ type: 'local', enabled, command }` object whose `command`
    // is a single argv array — the same CHAIN_V1 bootstrap, different envelope.
    const PUBLISHED_OPENCODE_ENTRY = {
      type: 'local',
      enabled: true,
      command: ['/bin/sh', '-l', '-c', CHAIN_V1],
    } as const;

    it('writes ~/.config/opencode/opencode.json under the mcp key', async () => {
      mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
      const result = await runInitForTest({ editors: ['opencode'] });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('opencode');
      expect(result.editors[0].action).toBe('written');

      const configPath = opencodeConfigPath();
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.mcp[result.editors[0].serverName]).toEqual(PUBLISHED_OPENCODE_ENTRY);
    });

    it('writes a project-scoped opencode.json at the project root', async () => {
      const _result = await runInitForTest({ editors: ['opencode'], scope: 'project' });

      const projectConfigPath = join(testDir, 'opencode.json');
      expect(existsSync(projectConfigPath)).toBe(true);

      const config = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
      expect(config.mcp['open-knowledge']).toEqual(PUBLISHED_OPENCODE_ENTRY);
    });

    it('writes the dev MCP entry with an environment block', async () => {
      mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
      enableDevMcp();
      const result = await runInitForTest({ editors: ['opencode'], devMcp: true });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].action).toBe('written');

      const config = JSON.parse(readFileSync(opencodeConfigPath(), 'utf-8'));
      expect(config.mcp[result.editors[0].serverName]).toEqual({
        type: 'local',
        enabled: true,
        command: ['node', join(devRepoRoot(), 'packages', 'cli', 'dist', 'cli.mjs'), 'mcp'],
        environment: { MCP_DEBUG: '1', OK_LOG_FILE: '/tmp/ok-mcp.log' },
      });
    });

    it('preserves existing OpenCode mcp entries', async () => {
      mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
      writeFileSync(
        opencodeConfigPath(),
        JSON.stringify({ mcp: { other: { type: 'local', command: ['node', 'x'] } } }, null, 2),
      );

      const result = await runInitForTest({ editors: ['opencode'] });
      expect(result.editors[0].action).toBe('written');

      const config = JSON.parse(readFileSync(opencodeConfigPath(), 'utf-8'));
      expect(config.mcp.other).toEqual({ type: 'local', command: ['node', 'x'] });
      expect(config.mcp[result.editors[0].serverName]).toEqual(PUBLISHED_OPENCODE_ENTRY);
    });

    it('writes a distinct project skill for Codex and OpenCode in their own dirs', async () => {
      const result = await runInitForTest({ editors: ['codex', 'opencode'], scope: 'project' });
      const codexSkill = join(testDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md');
      const opencodeSkill = join(testDir, '.opencode', 'skills', 'open-knowledge', 'SKILL.md');
      // Codex and OpenCode resolve to their OWN per-editor dirs (`.codex/skills`,
      // `.opencode/skills`) — not a shared `.agents/skills/` — so each writes a
      // distinct project-skill bundle (the resolved-path de-dupe is a no-op here).
      expect(result.projectSkills.some((s) => s.path === codexSkill)).toBe(true);
      expect(result.projectSkills.some((s) => s.path === opencodeSkill)).toBe(true);
      expect(existsSync(codexSkill)).toBe(true);
      expect(existsSync(opencodeSkill)).toBe(true);
      expect(existsSync(join(testDir, '.agents', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        false,
      );
    });
  });

  describe('Claude Desktop', () => {
    it('writes the same simple global open-knowledge entry as the local editors', async () => {
      const fakeHome = join(testDir, 'fakehome');
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });

      const result = await runInitForTest({ editors: ['claude-desktop'] });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('claude-desktop');
      expect(result.editors[0].action).toBe('written');
      expect(result.editors[0].serverName).toBe('open-knowledge');

      const configPath = resolveClaudeDesktopConfigPath({ home: fakeHome });
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const entry = config.mcpServers[result.editors[0].serverName];

      expect(entry).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('overwrites existing claude-desktop drift by default', async () => {
      const fakeHome = join(testDir, 'fakehome');
      mkdirSync(fakeHome, { recursive: true });

      const configPath = resolveClaudeDesktopConfigPath({ home: fakeHome });
      const configDir = dirname(configPath);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              'open-knowledge': {
                command: 'npx',
                args: ['some-old-package', 'mcp'],
              },
            },
          },
          null,
          2,
        ),
      );

      const result = await runInitForTest({ editors: ['claude-desktop'] });

      expect(result.editors[0].action).toBe('overwritten');

      const updatedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      const entry = updatedConfig.mcpServers[result.editors[0].serverName];
      expect(entry).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('renders a restart hint after writing the Claude Desktop config', async () => {
      const fakeHome = join(testDir, 'fakehome');
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });

      const result = await runInitForTest({ editors: ['claude-desktop'] });
      const output = formatInitResult(result, testDir);

      expect(output).toContain('quit and relaunch Claude Desktop to activate');
    });

    it('refuses Claude Desktop target on unsupported platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const result = await runInitForTest({ editors: ['claude-desktop'] });

      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].action).toBe('failed');
      expect(result.editors[0].error).toMatch(
        /Claude Desktop is not available on linux\. Supported: macOS, Windows\./,
      );
    });

    // Cowork bundle build (`ok cowork`) is a deliberately unadvertised power-user
    // escape hatch: `ok init` must NEVER push a hint toward it, even when the
    // Claude Desktop App is present. (The old `claudeDesktopDetected` result
    // field + its probe were removed with the hint — discovery is pull-only via
    // the Open Knowledge skill.)
    it('does NOT advertise the Cowork bundle, even when Claude Desktop is present', async () => {
      mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });

      const result = await runInitForTest();
      const output = formatInitResult(result, testDir);

      expect(output).not.toContain('ok cowork');
      expect(output).not.toContain('Claude Chat & Cowork');
      expect(output).not.toContain('openknowledge.skill');
    });
  });

  describe('multi-editor', () => {
    it('writes Claude + Cursor configs in a single run', async () => {
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      const result = await runInitForTest({ editors: ['claude', 'cursor'] });

      expect(result.editors).toHaveLength(2);
      expect(result.editors[0].editorId).toBe('claude');
      expect(result.editors[0].action).toBe('written');
      expect(result.editors[1].editorId).toBe('cursor');
      expect(result.editors[1].action).toBe('written');

      expect(existsSync(claudeConfigPath())).toBe(true);
      expect(existsSync(cursorConfigPath())).toBe(true);
    });

    it('writes all supported editors with editors: all', async () => {
      const fakeHome = join(testDir, 'fakehome');
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      mkdirSync(dirname(codexConfigPath()), { recursive: true });
      mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
      mkdirSync(join(fakeHome, '.openclaw'), { recursive: true });

      const result = await runInitForTest({ editors: [...ALL_EDITOR_IDS] });

      expect(result.editors).toHaveLength(ALL_EDITOR_IDS.length);
      for (const editor of result.editors) {
        expect(editor.action).toBe('written');
      }

      expect(existsSync(claudeConfigPath())).toBe(true);
      expect(existsSync(resolveClaudeDesktopConfigPath({ home: fakeHome }))).toBe(true);
      expect(existsSync(cursorConfigPath())).toBe(true);
      expect(existsSync(codexConfigPath())).toBe(true);
      expect(existsSync(opencodeConfigPath())).toBe(true);
      // OpenClaw nests under `mcp.servers` — verify the entry landed there.
      const openclawConfig = JSON.parse(
        readFileSync(join(fakeHome, '.openclaw', 'openclaw.json'), 'utf-8'),
      );
      expect(openclawConfig.mcp.servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('overwrites across all targeted editors', async () => {
      // Pre-populate Claude and Cursor with old entries
      writeFileSync(
        claudeConfigPath(),
        JSON.stringify({
          mcpServers: { 'open-knowledge': { command: 'old', args: [] } },
        }),
      );
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      writeFileSync(
        cursorConfigPath(),
        JSON.stringify({
          mcpServers: { 'open-knowledge': { command: 'old', args: [] } },
        }),
      );

      const result = await runInitForTest({
        editors: ['claude', 'cursor'],
      });

      expect(result.editors[0].action).toBe('overwritten');
      expect(result.editors[1].action).toBe('overwritten');

      const claude = JSON.parse(readFileSync(claudeConfigPath(), 'utf-8'));
      expect(claude.mcpServers[result.editors[0].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);

      const cursor = JSON.parse(readFileSync(cursorConfigPath(), 'utf-8'));
      expect(cursor.mcpServers[result.editors[1].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('mixed outcome — one editor declines (unparseable), others succeed', async () => {
      // An unparseable Cursor config is left untouched and declined, not reset;
      // Claude still registers. One bad config never blocks the others.
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      writeFileSync(cursorConfigPath(), '{broken');

      const result = await runInitForTest({ editors: ['claude', 'cursor'] });

      expect(result.editors[0].editorId).toBe('claude');
      expect(result.editors[0].action).toBe('written');
      expect(result.editors[1].editorId).toBe('cursor');
      expect(result.editors[1].action).toBe('declined');
      expect(result.editors[1].declineReason).toBe('unparseable');
      expect(readFileSync(cursorConfigPath(), 'utf-8')).toBe('{broken');
    });

    it('idempotent per-editor across two runs', async () => {
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      const first = await runInitForTest({ editors: ['claude', 'cursor'] });
      expect(first.editors.every((e) => e.action === 'written')).toBe(true);

      const second = await runInitForTest({ editors: ['claude', 'cursor'] });
      expect(second.editors.every((e) => e.action === 'overwritten')).toBe(true);
    });

    it('--no-mcp skips all editors', async () => {
      const result = await runInitForTest({
        editors: ['claude', 'cursor', 'codex'],
        mcp: false,
      });

      expect(result.editors).toHaveLength(3);
      for (const editor of result.editors) {
        expect(editor.action).toBe('skipped-flag');
      }
      expect(existsSync(claudeConfigPath())).toBe(false);
      expect(existsSync(cursorConfigPath())).toBe(false);
      expect(existsSync(codexConfigPath())).toBe(false);
    });

    it('surfaces legacy project-local MCP configs after writing global ones', async () => {
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      mkdirSync(join(testDir, '.cursor'), { recursive: true });
      writeFileSync(join(testDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      writeFileSync(
        join(testDir, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: {} }, null, 2),
      );

      const result = await runInitForTest({ editors: ['claude', 'cursor'] });

      expect(result.legacyProjectConfigs).toEqual(
        expect.arrayContaining([
          { editorId: 'claude', label: 'Claude', path: join(testDir, '.mcp.json') },
          { editorId: 'cursor', label: 'Cursor', path: join(testDir, '.cursor', 'mcp.json') },
        ]),
      );

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Project MCP configs found:');
      expect(output).toContain('.mcp.json');
      expect(output).toContain('.cursor/mcp.json');
    });

    it('renders launch.json beside the Claude MCP entry, not in the legacy warning block', async () => {
      mkdirSync(dirname(cursorConfigPath()), { recursive: true });
      mkdirSync(join(testDir, '.cursor'), { recursive: true });
      writeFileSync(join(testDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      writeFileSync(
        join(testDir, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: {} }, null, 2),
      );

      const result = await runInitForTest({ editors: ['claude', 'cursor'] });
      const output = formatInitResult(result, testDir);

      const claudeIndex = output.indexOf('Claude');
      const launchJsonIndex = output.indexOf('launch.json');
      const legacyIndex = output.indexOf('Project MCP configs found:');

      expect(output).toContain('app preview server');
      expect(claudeIndex).toBeGreaterThanOrEqual(0);
      expect(launchJsonIndex).toBeGreaterThan(claudeIndex);
      expect(legacyIndex).toBeGreaterThan(launchJsonIndex);
    });
  });

  // -----------------------------------------------------------------------
  // Claude launch.json scaffolding
  // -----------------------------------------------------------------------

  describe('launch.json scaffolding', () => {
    it('writes a fresh .claude/launch.json pointing at open-knowledge ui', async () => {
      const result = await runInitForTest();

      expect(result.launchJson).toBeDefined();
      expect(result.launchJson?.action).toBe('created');

      const configPath = join(testDir, '.claude', 'launch.json');
      expect(existsSync(configPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(parsed.configurations).toHaveLength(1);
      assertChainEntry(parsed.configurations[0]);
    });

    it('overwrites a stale open-knowledge-ui entry by default', async () => {
      const configPath = join(testDir, '.claude', 'launch.json');
      mkdirSync(join(testDir, '.claude'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            version: '0.0.1',
            configurations: [
              {
                name: 'open-knowledge-ui',
                runtimeExecutable: 'npx',
                runtimeArgs: ['open-knowledge', 'start'],
                port: 3000,
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = await runInitForTest();
      expect(result.launchJson?.action).toBe('merged');

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      assertChainEntry(parsed.configurations[0]);
    });

    it('writes a local dev launch target when --dev-mcp is enabled', async () => {
      enableDevMcp();
      const result = await runInitForTest({ devMcp: true });

      expect(result.launchJson?.action).toBe('created');

      const parsed = JSON.parse(readFileSync(join(testDir, '.claude', 'launch.json'), 'utf-8'));
      expect(parsed.configurations).toHaveLength(1);
      assertChainEntry(parsed.configurations[0], { devDist: devDistPath() });
    });

    it('rewrites an up-to-date open-knowledge-ui entry', async () => {
      const configPath = join(testDir, '.claude', 'launch.json');
      mkdirSync(join(testDir, '.claude'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            version: '0.0.1',
            configurations: [
              {
                name: 'open-knowledge-ui',
                runtimeExecutable: 'npx',
                runtimeArgs: ['@inkeep/open-knowledge', 'ui'],
                port: LAUNCH_JSON_PORT,
                autoPort: true,
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = await runInitForTest();
      expect(result.launchJson?.action).toBe('merged');
    });

    it('overwrites the published launch target in dev mode', async () => {
      const configPath = join(testDir, '.claude', 'launch.json');
      mkdirSync(join(testDir, '.claude'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            version: '0.0.1',
            configurations: [
              {
                name: 'open-knowledge-ui',
                runtimeExecutable: 'npx',
                runtimeArgs: ['@inkeep/open-knowledge', 'ui'],
                port: LAUNCH_JSON_PORT,
                autoPort: true,
              },
            ],
          },
          null,
          2,
        ),
      );

      enableDevMcp();
      const result = await runInitForTest({ devMcp: true });
      expect(result.launchJson?.action).toBe('merged');

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      assertChainEntry(parsed.configurations[0], { devDist: devDistPath() });
    });

    it('merges the new entry into an existing launch.json with other configurations', async () => {
      const configPath = join(testDir, '.claude', 'launch.json');
      mkdirSync(join(testDir, '.claude'), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            version: '0.0.1',
            configurations: [
              {
                name: 'some-other-server',
                runtimeExecutable: 'node',
                runtimeArgs: ['./server.js'],
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = await runInitForTest();
      expect(result.launchJson?.action).toBe('created');

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(parsed.configurations).toHaveLength(2);
      const ok = parsed.configurations.find(
        (c: { name: string }) => c.name === 'open-knowledge-ui',
      );
      assertChainEntry(ok);
      expect(ok.port).toBe(LAUNCH_JSON_PORT);
      expect(ok.autoPort).toBe(true);
    });

    it('does NOT scaffold launch.json when Claude is not among selected editors', async () => {
      const result = await runInitForTest({ editors: ['cursor'] });
      expect(result.launchJson).toBeUndefined();
      expect(existsSync(join(testDir, '.claude', 'launch.json'))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Zero project-root file writes
  // -----------------------------------------------------------------------

  describe('zero project-root file writes', () => {
    it('does not create root AGENTS.md when claude editor is selected', async () => {
      await runInitForTest({ editors: ['claude'] });

      expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(false);
    });

    it('does not create AGENTS.md for cursor', async () => {
      await runInitForTest({ mcp: false, editors: ['cursor'] });

      expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(testDir, '.cursorrules'))).toBe(false);
      expect(existsSync(join(testDir, '.cursor', 'rules', 'open-knowledge.mdc'))).toBe(false);
    });

    it('does not create any root-level agent files for claude + cursor combined', async () => {
      await runInitForTest({
        mcp: false,
        editors: ['claude', 'cursor'],
      });

      expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(testDir, '.cursor', 'rules', 'open-knowledge.mdc'))).toBe(false);
      expect(existsSync(join(testDir, '.cursorrules'))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Legacy-injection non-interference
  // -----------------------------------------------------------------------

  describe('legacy-injection non-interference', () => {
    it('leaves pre-existing open-knowledge marker blocks byte-identical in CLAUDE.md and AGENTS.md', async () => {
      const legacyClaudeBody = [
        '# My Project',
        '',
        'Some pre-existing content the user wrote themselves.',
        '',
        '<!-- open-knowledge:begin -->',
        '## Legacy OpenKnowledge section',
        'Pretend this was injected by an older ok init version.',
        '<!-- open-knowledge:end -->',
        '',
        'Post-section notes.',
        '',
      ].join('\n');
      const legacyAgentsBody = [
        '<!-- open-knowledge:begin -->',
        '## Legacy section in AGENTS.md',
        '<!-- open-knowledge:end -->',
        '',
        '# Project agents notes',
        '',
      ].join('\n');

      const claudePath = join(testDir, 'CLAUDE.md');
      const agentsPath = join(testDir, 'AGENTS.md');
      writeFileSync(claudePath, legacyClaudeBody, 'utf-8');
      writeFileSync(agentsPath, legacyAgentsBody, 'utf-8');

      const beforeClaude = readFileSync(claudePath, 'utf-8');
      const beforeAgents = readFileSync(agentsPath, 'utf-8');

      // Run init with a no-op skill install so we don't shell out to `npx skills`.
      await runInitForTest({ installUserSkill: async () => 'skip-current' });

      // Byte-identical pre/post — the new init code does NOT touch legacy injections.
      expect(readFileSync(claudePath, 'utf-8')).toBe(beforeClaude);
      expect(readFileSync(agentsPath, 'utf-8')).toBe(beforeAgents);
    });
  });

  // -----------------------------------------------------------------------
  // installUserSkill wiring
  // -----------------------------------------------------------------------

  describe('installUserSkill wiring', () => {
    it('returns skillInstall = "installed" when the install succeeds', async () => {
      const result = await runInitForTest({
        installUserSkill: async () => 'installed',
      });
      expect(result.skillInstall).toBe('installed');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('User-global skill:');
      expect(output).toContain('installed to detected agent hosts');
    });

    it('returns skillInstall = "skip-current" when the sidecar is current', async () => {
      const result = await runInitForTest({
        installUserSkill: async () => 'skip-current',
      });
      expect(result.skillInstall).toBe('skip-current');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('User-global skill:');
      expect(output).toContain('already installed at current version');
    });

    it('returns skillInstall = "failed" without throwing — init still exits 0 (QA-004)', async () => {
      const result = await runInitForTest({
        installUserSkill: async () => 'failed',
      });
      expect(result.skillInstall).toBe('failed');
      // MCP config still written successfully
      expect(result.mcpAction).toBe('written');
      // Manual-install hint surfaces in the summary
      const output = formatInitResult(result, testDir);
      expect(output).toContain('install failed');
      expect(output).toContain('npx skills');
    });

    it('passes opts.home through to installUserSkill (D15)', async () => {
      let capturedHome: string | undefined;
      await runInitForTest({
        installUserSkill: async (opts) => {
          capturedHome = opts?.home;
          return 'installed';
        },
      });
      expect(capturedHome).toBe(fakeHome);
    });

    it('FR6/D8: installs BOTH user-global bundles by default and records both enabled', async () => {
      const installed: (string | undefined)[] = [];
      await runInitForTest({
        installUserSkill: async (opts) => {
          installed.push(opts?.bundleId);
          return 'installed';
        },
      });
      expect(installed.sort()).toEqual(['discovery', 'write-skill']);
      // Decisions persisted so the desktop / start reclaim gates agree.
      expect(await readBundleDecision(fakeHome, 'open-knowledge-discovery')).toBe(true);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-write-skill')).toBe(true);
    });

    it('--no-skills installs nothing and records both declined', async () => {
      const installed: (string | undefined)[] = [];
      await runInitForTest({
        skills: false,
        installUserSkill: async (opts) => {
          installed.push(opts?.bundleId);
          return 'installed';
        },
      });
      expect(installed).toEqual([]);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-discovery')).toBe(false);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-write-skill')).toBe(false);
    });

    it('--skills discovery installs only discovery', async () => {
      const installed: (string | undefined)[] = [];
      await runInitForTest({
        skills: 'discovery',
        installUserSkill: async (opts) => {
          installed.push(opts?.bundleId);
          return 'installed';
        },
      });
      expect(installed).toEqual(['discovery']);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-discovery')).toBe(true);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-write-skill')).toBe(false);
    });

    it('installs every enabled bundle with force so the shared cli-hosts version key cannot skip the second', async () => {
      const forced: (boolean | undefined)[] = [];
      await runInitForTest({
        installUserSkill: async (opts) => {
          forced.push(opts?.force);
          return 'installed';
        },
      });
      // Both bundles must force-install; without force, bundle 1's version write
      // would satisfy bundle 2's skip-current gate and freeze its content.
      expect(forced).toEqual([true, true]);
    });

    it('--no-skills reports declined, not a false "already installed"', async () => {
      const result = await runInitForTest({
        skills: false,
        installUserSkill: async () => 'installed',
      });
      expect(result.skillInstall).toBe('declined');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('opted out');
      expect(output).not.toContain('already installed at current version');
    });

    it('surfaces the manual-install hint when one bundle fails even if the other installs', async () => {
      const result = await runInitForTest({
        installUserSkill: async (opts) =>
          opts?.bundleId === 'write-skill' ? 'failed' : 'installed',
      });
      expect(result.skillInstall).toBe('failed');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('install failed');
    });
  });

  // -----------------------------------------------------------------------
  // Content preview integration
  // -----------------------------------------------------------------------

  describe('content preview in init output', () => {
    it('renders Content block with file count and sample when preview succeeds', async () => {
      writeFileSync(join(testDir, 'readme.md'), '# Readme');
      mkdirSync(join(testDir, 'docs'));
      writeFileSync(join(testDir, 'docs', 'guide.md'), '# Guide');

      const result = await runInitForTest({ mcp: false });

      const preview = previewContent({
        projectDir: testDir,
        contentDir: testDir,
      });
      result.preview = preview;

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Content:');
      expect(output).toContain(`Found ${preview.totalCount} markdown files`);
      expect(output).toContain('Re-check anytime: open-knowledge preview');
    });

    it('renders warning line when preview is undefined with previewWarning', async () => {
      const result = await runInitForTest({ mcp: false });
      result.preview = undefined;
      result.previewWarning = 'something went wrong';

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Content preview unavailable: something went wrong');
      expect(output).not.toContain('Found');
    });

    it('omits Sample line when preview.totalCount is 0', async () => {
      const result = await runInitForTest({ mcp: false });
      result.preview = {
        totalCount: 0,
        sample: [],
        contentDir: testDir,
        warnings: [],
      };

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Found 0 markdown files');
      expect(output).not.toContain('Sample:');
    });

    it('renders an update summary when an MCP entry is replaced', async () => {
      writeFileSync(
        claudeConfigPath(),
        JSON.stringify(
          {
            mcpServers: {
              'open-knowledge': {
                command: 'node',
                args: ['./packages/cli/dist/cli.mjs', 'mcp'],
              },
            },
          },
          null,
          2,
        ),
      );

      const result = await runInitForTest();
      const output = formatInitResult(result, testDir);
      expect(result.editors[0].action).toBe('overwritten');
      expect(output).toContain('updated');
      expect(output).not.toContain('re-run with --force');
    });

    it('loadConfig + previewContent integration: preview picks up scaffolded config', async () => {
      writeFileSync(join(testDir, 'readme.md'), '# Readme');
      mkdirSync(join(testDir, 'docs'));
      writeFileSync(join(testDir, 'docs', 'guide.md'), '# Guide');

      const result = await runInitForTest({ mcp: false });

      const { config } = loadConfig(testDir);
      const contentDir = resolve(testDir, config.content.dir);
      const preview = previewContent({
        projectDir: testDir,
        contentDir,
      });
      result.preview = preview;

      expect(preview.totalCount).toBeGreaterThanOrEqual(2);
      expect(preview.sample.some((p) => p.includes('readme.md'))).toBe(true);

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Content:');
      expect(output).toContain(`Found ${preview.totalCount} markdown files`);
    });
  });

  // -------------------------------------------------------------------------
  // auto-git-init inside runInit
  // -------------------------------------------------------------------------

  describe('ensureProjectGit wiring (US-005)', () => {
    it('fresh tmpdir (no .git/) → runInit creates .git/ and reports didGitInit=true', async () => {
      // Use runInitForTest (defaultInstallUserSkill stub) — the real
      // installUserSkill shells out to `npx skills@~1.5.0 add` which
      // intermittently fails in CI sandboxes (subprocess returns nonzero
      // with empty stderr; exit code null) and times out the 5s budget.
      // The git-init wiring under test is independent of skill install,
      // so the hermetic stub is the right scope.
      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(existsSync(join(testDir, '.git/HEAD'))).toBe(true);
      const head = readFileSync(join(testDir, '.git/HEAD'), 'utf-8');
      expect(head).toBe('ref: refs/heads/main\n');

      // formatInitResult includes the disclosure line
      const output = formatInitResult(result, testDir);
      expect(output).toContain(`Initialized git repo at ${testDir}/.git/ (default branch: main)`);
    });

    it('pre-existing .git/HEAD → runInit does not re-init and reports didGitInit=false', async () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.git/HEAD'), 'ref: refs/heads/main\n');

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(false);
      // formatInitResult omits the disclosure line
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Initialized git repo at');
    });

    it('fresh tmpdir → also seeds project-root .gitignore with .DS_Store', async () => {
      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(true);
      const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.DS_Store');

      // formatInitResult discloses the seed
      const output = formatInitResult(result, testDir);
      expect(output).toContain(`Seeded .gitignore at ${testDir}/.gitignore (.DS_Store)`);
    });

    it('pre-existing .git/ → does NOT touch a hand-authored project-root .gitignore', async () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.git/HEAD'), 'ref: refs/heads/main\n');
      const original = '# user-authored\nnode_modules/\n';
      writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(false);
      expect(result.rootGitignoreCreated).toBe(false);
      const after = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(after).toBe(original);
      // Formatter omits the seed disclosure
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Seeded .gitignore');
    });

    it('fresh tmpdir WITH a pre-existing .gitignore → did-git-init but seed is skipped', async () => {
      // Edge case: user pre-staged a folder with their own .gitignore but no
      // .git/. ensureProjectGit runs `git init`; the seed helper sees the
      // existing file and skips. The fresh-git-init disclosure still fires;
      // the seed disclosure does not.
      const original = 'secrets.env\n';
      writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(false);
      expect(readFileSync(join(testDir, '.gitignore'), 'utf-8')).toBe(original);
      // Formatter suppresses the seed disclosure when rootGitignoreCreated is
      // false even though didGitInit fired — completes the 2×2 matrix.
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Seeded .gitignore');
    });

    it('symlink at .gitignore → seed helper throws but runInit completes (non-fatal contract)', async () => {
      // Pins the non-fatal contract of the CLI catch wrapping the seed helper.
      // assertNotSymlink throws when it sees a symlink at .gitignore; the catch
      // must swallow it so project creation still succeeds. Without this test,
      // a future refactor that re-throws would silently break the "seed is
      // convenience, never block project creation" contract.
      const sentinel = join(testDir, 'sentinel.txt');
      writeFileSync(sentinel, 'do-not-clobber', 'utf-8');
      symlinkSync(sentinel, join(testDir, '.gitignore'));

      const result = await runInitForTest({ editors: ['claude'] });

      // Fresh git init still ran.
      expect(result.didGitInit).toBe(true);
      // Seed was skipped (helper threw, catch swallowed → rootGitignoreCreated stays false).
      expect(result.rootGitignoreCreated).toBe(false);
      // .ok/ scaffold still landed (project creation succeeded).
      expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
      // Sentinel content is untouched — assertNotSymlink fired before any write.
      expect(readFileSync(sentinel, 'utf-8')).toBe('do-not-clobber');
    });

    it('git unusable everywhere → runInit surfaces the recoverable GitNotAvailableError (no content scaffolded)', async () => {
      // Bare git off PATH falls back to a usable git at an absolute path and
      // succeeds (covered at the server spine, project-git.test.ts) — so to
      // exercise the genuine "no git anywhere" case we also neutralize the
      // fallback paths (override the platform so its absolute fallback list is
      // absent on this host). The op then surfaces the recoverable typed error,
      // which runInit propagates unwrapped (the CLI action handler prints it and
      // exits EX_CONFIG/78).
      const originalPath = process.env.PATH;
      const originalPlatform = process.platform;
      process.env.PATH = '/nonexistent';
      Object.defineProperty(process, 'platform', {
        value: originalPlatform === 'win32' ? 'linux' : 'win32',
        configurable: true,
      });
      try {
        // Import the server error type lazily to keep the import surface minimal
        // for other tests in this file.
        const { GitNotAvailableError } = await import('@inkeep/open-knowledge-server');
        await expect(runInitForTest({ editors: ['claude'] })).rejects.toBeInstanceOf(
          GitNotAvailableError,
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
        process.env.PATH = originalPath;
      }

      // Content scaffolding must NOT have fired when the preflight threw.
      expect(existsSync(join(testDir, OK_DIR))).toBe(false);
      expect(existsSync(join(testDir, '.git'))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // MCP scope selection
  // -----------------------------------------------------------------------

  describe('mcp scope selection', () => {
    it('scope=user writes only user-level config (default runInitForTest behavior)', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'user' });
      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('claude');
      expect(result.editors[0].action).toBe('written');
      expect(result.editors[0].configScope).toBeUndefined();
      expect(existsSync(claudeConfigPath())).toBe(true);
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(false);
    });

    it('scope=user still writes the project-local skill (project-skill decoupled from MCP scope)', async () => {
      // The rich project skill rides with the repo regardless of MCP-config
      // scope — `scope=user` writes no project MCP config but still installs it.
      const result = await runInitForTest({ editors: ['claude'], scope: 'user' });
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(false);
      const claudeSkill = result.projectSkills.find((s) => s.editorId === 'claude');
      expect(claudeSkill?.action).toBe('written');
      expect(existsSync(join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('scope=project writes only project-level config for Claude', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'project' });
      // Only the project-scope result
      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('claude');
      expect(result.editors[0].action).toBe('written');
      expect(result.editors[0].configScope).toBe('project');
      expect(result.editors[0].configPath).toBe(join(testDir, '.mcp.json'));
      // User-level config should NOT be written
      expect(existsSync(claudeConfigPath())).toBe(false);
      // Project-level config IS written
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(true);
      expect(result.projectSkills).toHaveLength(1);
      expect(result.projectSkills[0]).toMatchObject({
        editorId: 'claude',
        action: 'written',
        path: join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'),
      });
      expect(existsSync(join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('scope=project writes project-level configs for claude, cursor, codex', async () => {
      const result = await runInitForTest({
        editors: ['claude', 'cursor', 'codex'],
        scope: 'project',
      });
      expect(result.editors).toHaveLength(3);
      for (const r of result.editors) {
        expect(r.configScope).toBe('project');
        expect(r.action).toBe('written');
      }
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(true);
      expect(existsSync(join(testDir, '.cursor', 'mcp.json'))).toBe(true);
      expect(existsSync(join(testDir, '.codex', 'config.toml'))).toBe(true);
      expect(result.projectSkills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            editorId: 'claude',
            action: 'written',
            path: join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'),
          }),
          expect.objectContaining({
            editorId: 'cursor',
            action: 'written',
            path: join(testDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'),
          }),
          expect.objectContaining({
            editorId: 'codex',
            action: 'written',
            path: join(testDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md'),
          }),
        ]),
      );
      expect(existsSync(join(testDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
      expect(existsSync(join(testDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('scope=project silently skips editors without projectConfigPath (claude-desktop)', async () => {
      const result = await runInitForTest({
        editors: ['claude-desktop'],
        scope: 'project',
      });
      // No entries since claude-desktop has no projectConfigPath
      expect(result.editors).toHaveLength(0);
    });

    it('scope=both writes user-level AND project-level for claude', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'both' });
      expect(result.editors).toHaveLength(2);
      const userResult = result.editors.find((r) => r.configScope !== 'project');
      const projResult = result.editors.find((r) => r.configScope === 'project');
      expect(userResult).toBeDefined();
      expect(projResult).toBeDefined();
      expect(userResult?.action).toBe('written');
      expect(projResult?.action).toBe('written');
      expect(existsSync(claudeConfigPath())).toBe(true);
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('scope=both suppresses project-config notice for paths just written', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'both' });
      // Even though .mcp.json now exists, it was written by us so should NOT appear in legacyProjectConfigs
      expect(result.legacyProjectConfigs).toHaveLength(0);
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Project MCP configs found:');
    });

    it('scope=project shows "(project)" label in output', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'project' });
      const output = formatInitResult(result, testDir);
      expect(output).toContain('Claude (project)');
      expect(output).toContain('Project-local skills:');
      expect(output).toContain('.claude/skills/open-knowledge/SKILL.md');
    });

    it('--no-mcp skips all MCP writes regardless of scope', async () => {
      const result = await runInitForTest({ editors: ['claude'], mcp: false, scope: 'both' });
      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].action).toBe('skipped-flag');
      expect(existsSync(claudeConfigPath())).toBe(false);
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(false);
    });

    it('--no-mcp still writes the project-local skill (SPEC 2026-05-19-ok-skill-split FR7 / AC7)', async () => {
      // Skills are decoupled from MCP-config writes: `--no-mcp` controls MCP
      // wiring only — the rich project skill still installs.
      const result = await runInitForTest({ editors: ['claude'], mcp: false });
      expect(result.editors[0].action).toBe('skipped-flag');
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(false);
      const claudeSkill = result.projectSkills.find((s) => s.editorId === 'claude');
      expect(claudeSkill?.action).toBe('written');
      expect(existsSync(join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('scope=both "Next steps" deduplicates editor labels (no double-count)', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'both' });
      const output = formatInitResult(result, testDir);
      // "Claude" should appear exactly once in the "Open your editor" line,
      // even though result.editors has two entries (user-scope + project-scope).
      const nextStepsLine = output.split('\n').find((l) => l.includes('Open your editor'));
      expect(nextStepsLine).toBeDefined();
      const matches = nextStepsLine?.match(/Claude/g);
      expect(matches).toHaveLength(1);
    });

    // ---------------------------------------------------------------------
    // Symlink-overwrite guard (project-scope) — a malicious repo can
    // plant `.mcp.json -> /etc/passwd` (or similar) and have `ok init`
    // follow the symlink and overwrite the target. Escape targets are
    // placed outside `testDir` (sibling tmp dirs) so the realpath
    // containment check sees them as outside cwd.
    // ---------------------------------------------------------------------

    const allocOutsideTestDir = (suffix: string): string =>
      resolve(
        tmpdir(),
        `init-symlink-escape-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );

    it('refuses project-scope write when target file is a symlink', async () => {
      const decoyTarget = allocOutsideTestDir('decoy');
      writeFileSync(decoyTarget, 'untouched\n', 'utf-8');
      try {
        symlinkSync(decoyTarget, join(testDir, '.mcp.json'));

        const result = await runInitForTest({ editors: ['claude'], scope: 'project' });

        const projResult = result.editors.find((r) => r.configScope === 'project');
        expect(projResult?.action).toBe('failed');
        expect(projResult?.error).toMatch(/symbolic link/);
        expect(readFileSync(decoyTarget, 'utf-8')).toBe('untouched\n');
        expect(lstatSync(join(testDir, '.mcp.json')).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(decoyTarget, { force: true });
      }
    });

    it('refuses project-scope write when an ancestor directory escapes cwd via symlink', async () => {
      const escapeTarget = allocOutsideTestDir('cursor-escape');
      mkdirSync(escapeTarget, { recursive: true });
      try {
        symlinkSync(escapeTarget, join(testDir, '.cursor'));

        const result = await runInitForTest({ editors: ['cursor'], scope: 'project' });

        const projResult = result.editors.find((r) => r.editorId === 'cursor');
        expect(projResult?.action).toBe('failed');
        expect(projResult?.error).toMatch(/outside the project directory/);
        expect(existsSync(join(escapeTarget, 'mcp.json'))).toBe(false);
      } finally {
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    it('refuses project-scope skill write when ancestor escapes cwd via symlink', async () => {
      const escapeTarget = allocOutsideTestDir('skill-escape');
      mkdirSync(escapeTarget, { recursive: true });
      try {
        // `.claude/skills` symlinked to a directory outside cwd. Without the
        // guard, `rmSync(targetDir, recursive:true)` followed by `cpSync`
        // would route through the symlink and clobber escape-target contents.
        mkdirSync(join(testDir, '.claude'), { recursive: true });
        symlinkSync(escapeTarget, join(testDir, '.claude', 'skills'));
        writeFileSync(join(escapeTarget, 'sentinel.txt'), 'untouched\n', 'utf-8');

        const result = await runInitForTest({ editors: ['claude'], scope: 'project' });

        const skill = result.projectSkills.find((s) => s.editorId === 'claude');
        expect(skill?.action).toBe('failed');
        expect(skill?.error).toMatch(/outside the project directory/);
        expect(readFileSync(join(escapeTarget, 'sentinel.txt'), 'utf-8')).toBe('untouched\n');
      } finally {
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    });

    it('allows project-scope write through a symlink that stays within cwd', async () => {
      // Legitimate use case: `.cursor` is a symlink to a sibling directory
      // INSIDE the project. Realpath resolves inside cwd → allow.
      const inProject = join(testDir, '.cursor-shared');
      mkdirSync(inProject, { recursive: true });
      symlinkSync(inProject, join(testDir, '.cursor'));

      const result = await runInitForTest({ editors: ['cursor'], scope: 'project' });

      const projResult = result.editors.find((r) => r.editorId === 'cursor');
      expect(projResult?.action).toBe('written');
      expect(existsSync(join(inProject, 'mcp.json'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// runInit — git-root promotion threading: returned `projectRoot` differs from
// the caller's `cwd` when cwd sits inside a git working tree. Post-init
// preview/format read from `projectRoot`, not `cwd`.
// ---------------------------------------------------------------------------

describe('runInit — projectRoot threading', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const originalPlatform = process.platform;
  const defaultInstallUserSkill = async () => 'installed' as const;

  beforeEach(() => {
    const rawDir = resolve(
      tmpdir(),
      `init-projectroot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(rawDir, { recursive: true });
    // macOS tmpdir is `/var/folders/...` which `realpathSync` canonicalizes to
    // `/private/var/...`. `resolveProjectRoot` realpath-s cwd before the git
    // descendant-of-home check, so the home arg must already be canonical or
    // descendant-checking fails (`/var/...` !startsWith `/private/var/...`).
    testDir = realpathSync(rawDir);
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns projectRoot equal to git root when cwd sits in a sub-folder', async () => {
    // Set up: fakeHome/repo (git root) + fakeHome/repo/sub (cwd).
    const repo = join(fakeHome, 'repo');
    const sub = join(repo, 'sub');
    mkdirSync(sub, { recursive: true });
    // Mock-git the repo: a `.git/HEAD` file is enough for `git rev-parse
    // --show-toplevel` substitutes; but the real call shells out, so write a
    // genuine repo via `git init` to keep the test true to production.
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    expect(existsSync(join(repo, '.git'))).toBe(true);

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    expect(result.projectRoot).toBe(repo);
    // .ok/ landed at the git root, not the sub-folder.
    expect(existsSync(join(repo, OK_DIR))).toBe(true);
    expect(existsSync(join(sub, OK_DIR))).toBe(false);
    // Promotion is flagged with the sub-folder it was promoted from so the
    // whole-repo-scope warning can name the folder to narrow back to.
    expect(result.gitRootPromoted).toBe(true);
    expect(result.promotedFromDir).toBe('sub');
    // The summary repeats the promotion as a prominent warning next to the
    // file count — not just the easy-to-miss top-of-run stderr line.
    const output = formatInitResult(result, result.projectRoot);
    expect(output).toContain('Content scope promoted to the git repo root');
    expect(output).toContain('content.dir: sub');
  });

  it('returns projectRoot equal to cwd when cwd is the git root', async () => {
    const repo = join(fakeHome, 'flat-repo');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    const result = await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    expect(result.projectRoot).toBe(repo);
    expect(existsSync(join(repo, OK_DIR))).toBe(true);
    // No promotion when init runs at the git root — no warning surfaces.
    expect(result.gitRootPromoted).toBe(false);
    expect(result.promotedFromDir).toBeUndefined();
    const output = formatInitResult(result, result.projectRoot);
    expect(output).not.toContain('Content scope promoted to the git repo root');
  });

  it('loadConfig succeeds when called against the resolved projectRoot', async () => {
    // The pre-fix wrapper called `loadConfig(cwd)` where cwd was the
    // sub-folder. Post git-root promotion, `.ok/config.yml` lives at the
    // git root — `loadConfig(cwd)` would resolve to defaults silently
    // (config-absent fall-through) instead of the project's actual config.
    // Asserting `loadConfig(projectRoot)` finds the just-scaffolded config
    // pins the contract.
    const repo = join(fakeHome, 'repo-loadconfig');
    const sub = join(repo, 'subdir');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    expect(result.projectRoot).toBe(repo);
    // .ok/config.yml lands at the git root.
    expect(existsSync(join(repo, OK_DIR, 'config.yml'))).toBe(true);
    // loadConfig from projectRoot finds it; loadConfig from cwd would not.
    const { config: rootConfig } = loadConfig(result.projectRoot);
    expect(rootConfig).toBeDefined();
    // content.dir defaults to the git root (`.`). Opened folder and content
    // scope intentionally align after git-root promotion — narrowing back to
    // the picked sub-folder is a deliberate post-init choice, not the silent
    // default.
    expect(rootConfig.content.dir).toBe('.');
  });

  it('--content-dir . from a sub-folder narrows scope to that folder', async () => {
    const repo = join(fakeHome, 'repo-cd-dot');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
      contentDir: '.',
    });

    // .ok/ still lands at the git root (one .ok/ per repo), but content.dir is
    // narrowed to the sub-folder the user ran in.
    expect(result.projectRoot).toBe(repo);
    expect(result.gitRootPromoted).toBe(true);
    expect(result.contentDir).toBe('notes');
    const { config } = loadConfig(result.projectRoot);
    expect(config.content.dir).toBe('notes');

    // The whole-repo surprise warning is suppressed; a scope confirmation shows.
    const output = formatInitResult(result, result.projectRoot);
    expect(output).not.toContain('Content scope promoted to the git repo root');
    expect(output).toContain('Content scope set to notes/');
  });

  it('--content-dir <subpath> narrows scope relative to cwd', async () => {
    const repo = join(fakeHome, 'repo-cd-sub');
    const nested = join(repo, 'docs', 'guides');
    mkdirSync(nested, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    const result = await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
      contentDir: 'docs/guides',
    });

    expect(result.projectRoot).toBe(repo);
    expect(result.contentDir).toBe('docs/guides');
    const { config } = loadConfig(result.projectRoot);
    expect(config.content.dir).toBe('docs/guides');
  });

  it('--content-dir outside the project root throws ContentDirError', async () => {
    const repo = join(fakeHome, 'repo-cd-escape');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    await expect(
      runInit({
        cwd: repo,
        home: fakeHome,
        installUserSkill: defaultInstallUserSkill,
        scope: 'user',
        contentDir: '..',
      }),
    ).rejects.toBeInstanceOf(ContentDirError);
    // Fail-fast: no .ok/ scaffolded when the flag is rejected.
    expect(existsSync(join(repo, OK_DIR))).toBe(false);
  });

  it('--content-dir on re-init is ignored (config.yml already exists) and warns', async () => {
    const repo = join(fakeHome, 'repo-cd-reinit');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    // First init: whole-repo scope.
    await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });
    expect(loadConfig(repo).config.content.dir).toBe('.');

    // Re-init with --content-dir: writeIfMissing leaves the existing config
    // untouched, so scope is NOT changed and the summary flags the ignored flag.
    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
      contentDir: '.',
    });
    expect(result.contentDir).toBeUndefined();
    expect(result.contentDirRequested).toBe('.');
    expect(result.contentScaffoldFailed).toBe(false);
    expect(loadConfig(repo).config.content.dir).toBe('.');
    const output = formatInitResult(result, result.projectRoot);
    expect(output).toContain('ignored');
    // JSON projection reflects the un-applied scope on re-init.
    expect(
      buildInitJsonSummary(result, { contentDir: '.', contentFileCount: null }).contentDirApplied,
    ).toBe(false);
  });

  it('does not claim "config.yml already exists" when content scaffolding failed', async () => {
    // A real result to derive the two contentDir===undefined shapes from.
    const repo = join(fakeHome, 'repo-scaffold-fail');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    const base = await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    // Scaffolding-failure shape: flag requested, no config written, scaffold failed.
    // The misleading "ignored — config.yml already exists" line must NOT appear.
    const scaffoldFailed = {
      ...base,
      contentDirRequested: 'notes',
      contentDir: undefined,
      contentScaffoldFailed: true,
    };
    expect(formatInitResult(scaffoldFailed, base.projectRoot)).not.toContain('ignored');

    // Pre-existing-config shape (same undefined contentDir, but scaffold succeeded):
    // the "ignored" line is correct and MUST appear.
    const configExisted = {
      ...base,
      contentDirRequested: 'notes',
      contentDir: undefined,
      contentScaffoldFailed: false,
    };
    expect(formatInitResult(configExisted, base.projectRoot)).toContain('ignored');
  });

  it('buildInitJsonSummary projects a promoted, narrowed result into stable JSON fields', async () => {
    const repo = join(fakeHome, 'repo-json');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
      contentDir: '.',
    });

    const summary = buildInitJsonSummary(result, { contentDir: 'notes', contentFileCount: 3 });
    expect(summary.projectRoot).toBe(repo);
    expect(summary.gitRootPromoted).toBe(true);
    expect(summary.promotedFromDir).toBe('notes');
    expect(summary.contentDir).toBe('notes');
    expect(summary.contentDirRequested).toBe('.');
    expect(summary.contentDirApplied).toBe(true);
    expect(summary.contentFileCount).toBe(3);
    // A successful preview leaves previewError null so a null count means 0.
    expect(summary.previewError).toBeNull();
    // Round-trips through JSON without loss (the scriptable contract).
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('buildInitJsonSummary surfaces previewError so a null count is unambiguous', async () => {
    const repo = join(fakeHome, 'repo-json-previewerr');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    const base = await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });
    // Preview failed: null count MUST be paired with a non-null previewError.
    const withPreviewError = { ...base, previewWarning: 'cannot access content directory' };
    const summary = buildInitJsonSummary(withPreviewError, {
      contentDir: '.',
      contentFileCount: null,
    });
    expect(summary.contentFileCount).toBeNull();
    expect(summary.previewError).toBe('cannot access content directory');
  });

  it('buildInitJsonSummary uses null for absent promotion / request / count', async () => {
    const repo = join(fakeHome, 'repo-json-flat');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    const result = await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    const summary = buildInitJsonSummary(result, { contentDir: '.', contentFileCount: null });
    expect(summary.gitRootPromoted).toBe(false);
    expect(summary.promotedFromDir).toBeNull();
    expect(summary.contentDirRequested).toBeNull();
    expect(summary.contentDirApplied).toBe(true);
    expect(summary.contentFileCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveRequestedContentDir — pure path validation
// ---------------------------------------------------------------------------

describe('resolveRequestedContentDir', () => {
  let root: string;
  beforeEach(() => {
    const raw = join(tmpdir(), `rrcd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    // realpath so macOS `/var` → `/private/var` canonicalization matches what
    // `resolveRequestedContentDir` computes internally.
    root = realpathSync(raw);
    mkdirSync(join(root, 'sub'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns "." when the request resolves to the project root itself', () => {
    expect(resolveRequestedContentDir('.', root, root)).toBe('.');
  });

  it('returns the git-root-relative path for a descendant (cwd-relative input)', () => {
    // cwd = root, input "sub" → "sub".
    expect(resolveRequestedContentDir('sub', root, root)).toBe('sub');
    // cwd = root/sub, input "." → "sub".
    expect(resolveRequestedContentDir('.', root, join(root, 'sub'))).toBe('sub');
  });

  it('throws when the resolved path escapes the project root', () => {
    expect(() => resolveRequestedContentDir('..', root, root)).toThrow(ContentDirError);
  });

  it('throws when the path does not exist', () => {
    expect(() => resolveRequestedContentDir('nope', root, root)).toThrow(ContentDirError);
  });

  it('throws when the path is a file, not a directory', () => {
    writeFileSync(join(root, 'file.md'), '# x');
    expect(() => resolveRequestedContentDir('file.md', root, root)).toThrow(ContentDirError);
  });

  it('reports a non-ENOENT stat error as "not accessible", not "does not exist"', () => {
    // A path whose parent segment is a file yields ENOTDIR from statSync — the
    // bare catch used to mislabel this as "does not exist".
    writeFileSync(join(root, 'file.md'), '# x');
    let msg = '';
    try {
      resolveRequestedContentDir('file.md/nested', root, root);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('not accessible');
    expect(msg).not.toContain('does not exist');
  });

  it('resolves . when cwd reaches the project via a symlinked prefix', () => {
    // Simulate a symlinked working tree (macOS /var -> /private/var): the
    // canonical projectRoot and a symlink-prefixed cwd point at the same dir.
    // Pre-fix this threw ContentDirError because the two prefixes disagreed.
    const linkParent = join(
      tmpdir(),
      `rrcd-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    symlinkSync(root, linkParent);
    try {
      // `root` is realpath-canonical; `linkParent` is the un-canonical prefix.
      expect(resolveRequestedContentDir('.', root, linkParent)).toBe('.');
      expect(resolveRequestedContentDir('sub', root, linkParent)).toBe('sub');
    } finally {
      rmSync(linkParent, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMcpScope — TTY / non-TTY branch coverage
// ---------------------------------------------------------------------------

describe('resolveMcpScope', () => {
  it('returns "user" when --scope user is passed, without calling promptFn', async () => {
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => {
      throw new Error('promptFn should not be called');
    };
    const result = await resolveMcpScope({ scope: 'user', promptFn });
    expect(result).toBe('user');
  });

  it('returns "project" when --scope project is passed, without calling promptFn', async () => {
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => {
      throw new Error('promptFn should not be called');
    };
    const result = await resolveMcpScope({ scope: 'project', promptFn });
    expect(result).toBe('project');
  });

  it('returns "both" when --scope both is passed, without calling promptFn', async () => {
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => {
      throw new Error('promptFn should not be called');
    };
    const result = await resolveMcpScope({ scope: 'both', promptFn });
    expect(result).toBe('both');
  });

  it('returns "both" in non-TTY mode (isTTY=false), without calling promptFn', async () => {
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => {
      throw new Error('promptFn should not be called');
    };
    const result = await resolveMcpScope({ isTTY: false, promptFn });
    expect(result).toBe('both');
  });

  it('calls promptFn and returns its result in TTY mode (isTTY=true)', async () => {
    let called = false;
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => {
      called = true;
      return 'project';
    };
    const result = await resolveMcpScope({ isTTY: true, promptFn });
    expect(called).toBe(true);
    expect(result).toBe('project');
  });

  it('returns null when --no-mcp (mcp=false), without calling promptFn', async () => {
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => {
      throw new Error('promptFn should not be called');
    };
    const result = await resolveMcpScope({ mcp: false, isTTY: true, promptFn });
    expect(result).toBeNull();
  });

  it('returns null when promptFn returns null (user cleared both checkboxes — equivalent to --no-mcp)', async () => {
    const promptFn = async (): Promise<'user' | 'project' | 'both' | null> => null;
    const result = await resolveMcpScope({ isTTY: true, promptFn });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// initCommand -- Commander option validation
// ---------------------------------------------------------------------------

describe('initCommand', () => {
  it('rejects --scope with an invalid value (non-zero exit)', () => {
    const cmd = initCommand();
    cmd.exitOverride();
    expect(() => cmd.parse(['--scope', 'bogus'], { from: 'user' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// detectInstalledEditors
// ---------------------------------------------------------------------------

describe('detectInstalledEditors', () => {
  let testDir: string;
  let fakeHome: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  const cursorConfigPath = () => resolveCursorConfigPath({ home: fakeHome });
  const codexConfigPath = () => resolveCodexConfigPath({ home: fakeHome, env: {} });
  const opencodeConfigPath = () => resolveOpenCodeConfigPath({ home: fakeHome, env: {} });

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `detect-editors-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('detects Claude when ~/.claude exists', async () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toContain('claude');
  });

  it('does NOT detect Claude when ~/.claude is absent', async () => {
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).not.toContain('claude');
  });

  it('detects Cursor when ~/.cursor/ exists', async () => {
    mkdirSync(dirname(cursorConfigPath()), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toContain('cursor');
  });

  it('does NOT detect Cursor when ~/.cursor/ is absent', async () => {
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).not.toContain('cursor');
  });

  it('detects Codex when ~/.codex/ exists', async () => {
    mkdirSync(dirname(codexConfigPath()), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toContain('codex');
  });

  it('detects Claude Desktop when its config directory exists', async () => {
    mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toContain('claude-desktop');
  });

  it('does NOT detect Claude Desktop when its config dir is absent', async () => {
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).not.toContain('claude-desktop');
  });

  it('returns all supported editors when all editor config dirs exist', async () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });
    mkdirSync(dirname(cursorConfigPath()), { recursive: true });
    mkdirSync(dirname(codexConfigPath()), { recursive: true });
    mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
    mkdirSync(join(fakeHome, '.openclaw'), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toEqual(expect.arrayContaining([...ALL_EDITOR_IDS]));
    expect(detected).toHaveLength(ALL_EDITOR_IDS.length);
  });

  it('preserves EDITOR_TARGETS ordering in return value', async () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });
    mkdirSync(dirname(cursorConfigPath()), { recursive: true });
    mkdirSync(dirname(codexConfigPath()), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    // Order comes from ALL_EDITOR_IDS = ['claude', 'claude-desktop', 'cursor', 'codex']
    expect(detected).toEqual(['claude', 'claude-desktop', 'cursor', 'codex']);
  });

  it('returns empty list when the cwd itself does not exist (zero-detected edge case)', () => {
    // Synthesizes the "zero detected" path where init should skip MCP wiring
    // rather than inventing new editor config roots.
    const missingCwd = join(testDir, 'does-not-exist');
    const missingHome = join(testDir, 'also-not-here');
    const detected = detectInstalledEditors(missingCwd, missingHome);
    expect(detected).toEqual([]);
  });
});

describe('writeUserMcpConfigs', () => {
  let fakeHome: string;
  let testDir: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  const CANONICAL = PUBLISHED_CHAIN_ENTRY;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `write-user-mcp-configs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes the canonical chain shape for every selected editor', async () => {
    const results: EditorMcpResult[] = await writeUserMcpConfigs({
      editors: ['claude', 'cursor'],
      home: fakeHome,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === 'written')).toBe(true);

    const claudeConfig = JSON.parse(
      readFileSync(resolveClaudeCodeConfigPath({ home: fakeHome }), 'utf-8'),
    );
    expect(claudeConfig.mcpServers['open-knowledge']).toEqual(CANONICAL);

    const cursorConfig = JSON.parse(
      readFileSync(resolveCursorConfigPath({ home: fakeHome }), 'utf-8'),
    );
    expect(cursorConfig.mcpServers['open-knowledge']).toEqual(CANONICAL);
  });

  it('creates OK entry into a blank config with no .broken sidecar', async () => {
    const claudePath = resolveClaudeCodeConfigPath({ home: fakeHome });
    mkdirSync(dirname(claudePath), { recursive: true });
    // A whitespace-only config classifies as creatable, so the write populates
    // it rather than declining — and never renames it aside.
    writeFileSync(claudePath, '   \n');

    const results: EditorMcpResult[] = await writeUserMcpConfigs({
      editors: ['claude'],
      home: fakeHome,
    });
    expect(results[0]?.action).toBe('written');

    const config = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(config.mcpServers['open-knowledge']).toEqual(CANONICAL);

    // No `.broken-*` sidecar was produced next to the config.
    expect(readdirSync(dirname(claudePath)).some((name) => name.includes('.broken-'))).toBe(false);
  });

  it('does NOT create project-scoped side effects under the fake HOME', async () => {
    await writeUserMcpConfigs({ editors: ['claude', 'cursor'], home: fakeHome });

    expect(existsSync(join(fakeHome, '.git'))).toBe(false);
    expect(existsSync(join(fakeHome, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(fakeHome, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(fakeHome, '.claude', 'launch.json'))).toBe(false);
    expect(existsSync(join(fakeHome, OK_DIR))).toBe(false);
    expect(existsSync(join(fakeHome, '.mcp.json'))).toBe(false);
  });

  it('unconditionally overwrites a differing existing entry', async () => {
    const claudePath = resolveClaudeCodeConfigPath({ home: fakeHome });
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify(
        { mcpServers: { 'open-knowledge': { command: 'custom', args: ['old'] } } },
        null,
        2,
      ),
    );

    const results = await writeUserMcpConfigs({ editors: ['claude'], home: fakeHome });

    expect(results[0].action).toBe('overwritten');
    const config = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(config.mcpServers['open-knowledge']).toEqual(CANONICAL);
  });

  it('caller controls which editors get overwritten by omitting them from the editors array', async () => {
    const claudePath = resolveClaudeCodeConfigPath({ home: fakeHome });
    const cursorPath = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(claudePath), { recursive: true });
    mkdirSync(dirname(cursorPath), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify({ mcpServers: { 'open-knowledge': { command: 'custom', args: ['a'] } } }),
    );
    writeFileSync(
      cursorPath,
      JSON.stringify({ mcpServers: { 'open-knowledge': { command: 'custom', args: ['b'] } } }),
    );

    const results = await writeUserMcpConfigs({ editors: ['claude'], home: fakeHome });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('overwritten');
    expect(JSON.parse(readFileSync(claudePath, 'utf-8')).mcpServers['open-knowledge']).toEqual(
      CANONICAL,
    );
    expect(JSON.parse(readFileSync(cursorPath, 'utf-8')).mcpServers['open-knowledge']).toEqual({
      command: 'custom',
      args: ['b'],
    });
  });

  it('preserves unrelated mcpServers entries when writing the managed entry', async () => {
    const claudePath = resolveClaudeCodeConfigPath({ home: fakeHome });
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x.js'] } } }, null, 2),
    );

    await writeUserMcpConfigs({ editors: ['claude'], home: fakeHome });

    const config = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(config.mcpServers.other).toEqual({ command: 'node', args: ['x.js'] });
    expect(config.mcpServers['open-knowledge']).toEqual(CANONICAL);
  });

  it('reports action:failed for unsupported editors without throwing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const results = await writeUserMcpConfigs({ editors: ['claude-desktop'], home: fakeHome });

    expect(results[0].action).toBe('failed');
    expect(results[0].error).toMatch(/Claude Desktop is not available on linux/);
  });
});

/**
 * Direct unit coverage for `readExistingMcpEntry`.
 *
 * The function is the consent-flow tolerance boundary: every reachable
 * fail mode (config absent, config unparseable, top-level not an object,
 * server entry not an object, configPath throws on platform mismatch) MUST
 * return `null`, never throw. A regression that makes any branch throw
 * crashes `confirmHandler`, leaves the marker absent, and creates an infinite
 * dialog re-fire loop on user machines with corrupted editor configs.
 *
 * The orchestration tests in `mcp-wiring.test.ts` stub this function, so
 * direct coverage here is the only guard against tolerance regressions.
 */
describe('writeEditorMcpConfig — TOML fallback declines a present config', () => {
  let fakeHome: string;
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `toml-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    // Force the JS fallback: no native format-preserving engine available.
    setTomlConfigEngineForTesting(createTomlConfigEngine(() => null));
  });

  afterEach(() => {
    // Restore the lazily-resolved (native) engine so sibling suites that rely
    // on capable parsing are not poisoned by this one's forced fallback.
    setTomlConfigEngineForTesting(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('declines a present config rather than the lossy whole-file write, byte-unchanged', () => {
    const path = EDITOR_TARGETS.codex.configPath('', fakeHome);
    mkdirSync(dirname(path), { recursive: true });
    const original =
      '# do not clobber my comments\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "node"\n';
    writeFileSync(path, original, 'utf-8');

    const result = writeEditorMcpConfig(
      EDITOR_TARGETS.codex,
      '',
      { skipAvailabilityCheck: true },
      fakeHome,
    );

    expect(result.action).toBe('declined');
    expect(result.declineReason).toBe('no-native-writer');
    // The user's config is left exactly as they wrote it — no lossy rewrite.
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(readdirSync(dirname(path)).some((n) => n.includes('.broken-'))).toBe(false);
  });

  it('still creates OK’s entry into a blank config on the fallback (nothing to preserve)', () => {
    const path = EDITOR_TARGETS.codex.configPath('', fakeHome);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '   \n', 'utf-8');

    const result = writeEditorMcpConfig(
      EDITOR_TARGETS.codex,
      '',
      { skipAvailabilityCheck: true },
      fakeHome,
    );

    expect(result.action).toBe('written');
    const written = readFileSync(path, 'utf-8');
    expect(written).toContain('mcp_servers');
    expect(written).toContain('open-knowledge');
  });
});

describe('readExistingMcpEntry (Pass 0 Major #13)', () => {
  let fakeHome: string;
  let testDir: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `read-existing-mcp-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when the editor config file is absent', () => {
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('returns null when configPath throws (platform-mismatched target)', () => {
    // Claude Desktop's configPath only resolves on macOS / Windows. Switch to
    // linux so the configPath helper throws — readExistingMcpEntry MUST
    // catch + return null rather than propagate the throw.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(readExistingMcpEntry(EDITOR_TARGETS['claude-desktop'], '', fakeHome)).toBeNull();
  });

  it('returns null on invalid JSON (corrupt config)', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ this is not valid JSON', 'utf-8');
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('returns null on invalid TOML (corrupt Codex config)', () => {
    const path = resolveCodexConfigPath({ home: fakeHome, env: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not = valid = toml = at = all', 'utf-8');
    expect(readExistingMcpEntry(EDITOR_TARGETS.codex, '', fakeHome)).toBeNull();
  });

  it('returns null when top-level mcpServers key is not an object (e.g. array)', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: ['not', 'an', 'object'] }), 'utf-8');
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('returns null when the server entry exists but is not an object', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { 'open-knowledge': 'not-an-object' } }),
      'utf-8',
    );
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('returns the parsed entry when JSON config is well-formed', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const entry = { command: 'npx', args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'] };
    writeFileSync(path, JSON.stringify({ mcpServers: { 'open-knowledge': entry } }), 'utf-8');
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual(entry);
  });

  it('returns the parsed entry when TOML config (Codex) is well-formed', () => {
    const path = resolveCodexConfigPath({ home: fakeHome, env: {} });
    mkdirSync(dirname(path), { recursive: true });
    // Codex's `mcp_servers."open-knowledge"` table — quoted key form so the
    // TOML parser keeps the dash-bearing name as one identifier (per
    // smol-toml grammar). Same shape Codex itself writes via `ok init`.
    writeFileSync(
      path,
      '[mcp_servers."open-knowledge"]\ncommand = "npx"\nargs = ["-y", "@inkeep/open-knowledge@latest", "mcp"]\n',
      'utf-8',
    );
    const result = readExistingMcpEntry(EDITOR_TARGETS.codex, '', fakeHome);
    expect(result).toEqual({
      command: 'npx',
      args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'],
    });
  });

  it('returns null when config has the top-level key but no entry for our serverName', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { 'some-other-server': { command: 'foo' } } }),
      'utf-8',
    );
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('returns null when the file exists but is empty', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', 'utf-8');
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });
});

describe('classifyExistingMcpEntry', () => {
  let fakeHome: string;
  let testDir: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `classify-mcp-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('absent when the file does not exist', () => {
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'absent',
    });
  });

  it('absent when configPath throws (platform-mismatched target)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(classifyExistingMcpEntry(EDITOR_TARGETS['claude-desktop'], '', fakeHome)).toEqual({
      kind: 'absent',
    });
  });

  it('absent (creatable) when the file is blank (zero bytes)', () => {
    // A 0-byte config holds nothing to preserve, so it is safe to create into
    // rather than decline — this is what lets the write path populate it
    // without renaming it aside.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'absent',
    });
  });

  it('absent (creatable) when the file is whitespace-only', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '   \n\n  \t  ', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'absent',
    });
  });

  it('decline with a bounded reason on invalid JSON — never a creatable kind, no raw contents', () => {
    // toEqual is exact: it pins the reason to the bounded enum value and
    // proves no raw parser message / file path rides along in the result.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not valid JSON', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'unparseable',
    });
  });

  it('decline with a bounded reason on invalid TOML (Codex)', () => {
    const path = resolveCodexConfigPath({ home: fakeHome, env: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not = valid = toml = at = all', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.codex, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'unparseable',
    });
  });

  it.skipIf(!NATIVE_TOML_AVAILABLE)(
    'no-entry (not decline) on a valid Codex config with a 2^53+ integer',
    () => {
      // The capable engine parses an i64 the JS parser threw on, so a valid
      // config without OK's entry is seen as no-entry — the destructive branch
      // that reset such a file can no longer fire. Requires the native addon
      // (built by the gate); on the JS fallback this same input would decline,
      // which is non-destructive but does not register.
      const path = resolveCodexConfigPath({ home: fakeHome, env: {} });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        '# keep my comments\nmodel = "gpt-5"\n[mcp_servers.other]\ncommand = "node"\nstartup_timeout_ms = 9223372036854775807\n',
        'utf-8',
      );
      expect(classifyExistingMcpEntry(EDITOR_TARGETS.codex, '', fakeHome)).toEqual({
        kind: 'no-entry',
      });
    },
  );

  it('present on a valid Codex config with a microsecond datetime and OK entry', () => {
    const path = resolveCodexConfigPath({ home: fakeHome, env: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      'last_seen = 2026-06-26T12:34:56.123456Z\n[mcp_servers."open-knowledge"]\ncommand = "npx"\nargs = ["-y", "@inkeep/open-knowledge@latest", "mcp"]\n',
      'utf-8',
    );
    const result = classifyExistingMcpEntry(EDITOR_TARGETS.codex, '', fakeHome);
    expect(result.kind).toBe('present');
  });

  it('no-entry when JSON parses but has no mcpServers key', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1 }), 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'no-entry',
    });
  });

  it('no-entry when mcpServers exists but our serverName is absent', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { 'other-tool': { command: 'foo' } } }),
      'utf-8',
    );
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'no-entry',
    });
  });

  it('present with the parsed entry when our server entry exists', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const entry = { command: 'npx', args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'] };
    writeFileSync(path, JSON.stringify({ mcpServers: { 'open-knowledge': entry } }), 'utf-8');
    const result = classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome);
    expect(result).toEqual({ kind: 'present', entry });
  });

  it('decline (not creatable-blank) on a half-written / truncated JSON config', () => {
    // A harness writing the file concurrently can be read mid-write: the bytes
    // are a valid JSON prefix cut off, not blank. It must classify as decline
    // so the config is left alone, never as absent-and-creatable.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '{\n  "mcpServers": {\n    "open-knowledge": {\n      "command": "np',
      'utf-8',
    );
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome).kind).toBe('decline');
  });

  it('decline (not creatable-blank) on a half-written / truncated TOML config', () => {
    const path = resolveCodexConfigPath({ home: fakeHome, env: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[mcp_servers."open-knowledge"]\ncommand = "np', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.codex, '', fakeHome).kind).toBe('decline');
  });

  it('leaves a declined config byte-unchanged — classify never modifies or renames it', () => {
    // Guest-ownership: OK reads to classify but never writes on the read path,
    // so a present file it can't parse stays exactly as the user left it.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const original = '{ "mcpServers": [ deliberately malformed\n';
    writeFileSync(path, original, 'utf-8');

    const result = classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome);

    expect(result.kind).toBe('decline');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    // readExistingMcpEntry collapses a decline to null with the same read-only contract.
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('no-entry on a JSONC config with // and block comments (not unparseable)', () => {
    // Harness configs are frequently hand-edited JSONC; comments must not flip a
    // valid config to a decline that silently skips registration.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{\n  // my servers\n  "other": { "command": "x" } /* keep */\n}', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'no-entry',
    });
  });

  it('present on a JSONC config whose comments and trailing commas surround our entry', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const entry = { command: 'npx', args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'] };
    writeFileSync(
      path,
      `{\n  // managed by ok\n  "mcpServers": {\n    "open-knowledge": ${JSON.stringify(entry)}, // ours\n  },\n}`,
      'utf-8',
    );
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'present',
      entry,
    });
  });

  it('present on a config with a leading UTF-8 BOM (InvalidSymbol@0 is not corruption)', () => {
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const entry = { command: 'npx', args: ['-y', '@inkeep/open-knowledge@latest', 'mcp'] };
    writeFileSync(
      path,
      `\uFEFF${JSON.stringify({ mcpServers: { 'open-knowledge': entry } })}`,
      'utf-8',
    );
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'present',
      entry,
    });
  });

  it('decline (duplicate-container) when the mcpServers container appears twice', () => {
    // The value parse keeps only the last block, so an edit would target one
    // arbitrarily; the ambiguity is a decline, never a silent pick.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '{ "mcpServers": { "a": { "command": "x" } }, "mcpServers": { "b": { "command": "y" } } }',
      'utf-8',
    );
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'duplicate-container',
    });
  });

  it('duplicate-container is keyed to each harness container, not a hardcoded mcpServers', () => {
    // OpenCode nests servers under `mcp`; the duplicate check reads the target's
    // real container key.
    const path = resolveOpenCodeConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ "mcp": { "a": {} }, "mcp": { "b": {} } }', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.opencode, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'duplicate-container',
    });
  });

  it('no-entry (not duplicate-container) when only an unrelated sibling key repeats', () => {
    // Only a duplicated CONTAINER key is ambiguous for our edit; a repeated
    // sibling key the value parse resolves on its own is none of our business.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '{ "theme": "dark", "theme": "light", "mcpServers": { "other": {} } }',
      'utf-8',
    );
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'no-entry',
    });
  });

  it('decline (oversize) on a config past the size bound — gated before the parse, left byte-unchanged', () => {
    // A history-bloated `~/.claude.json` can reach tens of MB; classify must
    // stat-gate BEFORE reading+parsing. This payload is valid JSON whose only
    // disqualifier is its size — without the gate it would classify `no-entry`
    // (empty `mcpServers`), so an `oversize` decline proves the gate fired
    // ahead of the parse and matches the write path's oversize decline.
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const oversized = `{ "mcpServers": {}, "_history": "${'x'.repeat(11 * 1024 * 1024)}" }`;
    writeFileSync(path, oversized, 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'oversize',
    });
    // Guest-ownership: the giant file is left exactly as the user left it.
    expect(readFileSync(path, 'utf-8')).toBe(oversized);
  });
});

// ---------------------------------------------------------------------------
// Sharing mode
// ---------------------------------------------------------------------------

describe('runInit — sharing mode', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const defaultInstallUserSkill = async () => 'installed' as const;
  const runInitForTest = async (
    options: Parameters<typeof runInit>[0] = {},
  ): Promise<Awaited<ReturnType<typeof runInit>>> =>
    runInit({
      cwd: testDir,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
      // Pin isTTY to false so the prompt never fires implicitly — tests
      // inject explicit `sharing` or `sharingPromptFn` when they need a
      // specific posture.
      isTTY: false,
      ...options,
    });

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `init-sharing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('AC1: fresh `ok init --local-only` writes the OK artifact set to .git/info/exclude', async () => {
    const result = await runInitForTest({ sharing: 'local-only' });
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('local-only');
    expect(result.sharing.appended.length).toBeGreaterThan(0);
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.ok/');
    expect(exclude).toContain('.mcp.json');
    expect(exclude).toContain('.claude/launch.json');
  });

  it('AC3: --local-only in a non-git dir surfaces a no-exclude/no-git outcome (applySharingMode unit)', async () => {
    // runInit always invokes ensureProjectGit, so the genuinely-non-git
    // path is unreachable from runInit itself. Test the underlying
    // applySharingMode helper directly — that's where the no-git +
    // localOnlyRequested branch lives. The CLI integration sits in
    // formatSharingOutcome (covered by the sibling test below).
    const nonGit = resolve(
      tmpdir(),
      `init-sharing-nongit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = await applySharingMode({
        projectRoot: nonGit,
        desiredMode: 'local-only',
        explicitFlag: 'local-only',
      });
      expect(result).toEqual({
        kind: 'no-exclude',
        reason: 'no-git',
        localOnlyRequested: true,
      });
      expect(existsSync(join(nonGit, '.git'))).toBe(false);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('formatSharingOutcome renders the explicit --local-only-without-git warning', () => {
    const lines = formatSharingOutcome(
      { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: true },
      '/tmp/proj',
    );
    const text = lines.join('\n');
    expect(text).toMatch(/--local-only requested but no git repo/);
    expect(text).toMatch(/git init/);
    expect(text).toMatch(/ok config-sharing unshare/);
  });

  it('formatSharingOutcome is silent on no-git when no explicit flag was set', () => {
    const lines = formatSharingOutcome(
      { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: false },
      '/tmp/proj',
    );
    expect(lines).toEqual([]);
  });

  it('AC4: `ok init` (no flag, non-TTY) on a fresh repo preserves `shared` default — no exclude write', async () => {
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('shared');
    expect(result.sharing.action).toBe('noop');
    // The exclude file (created by git init) must not have any OK paths.
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).not.toContain('.ok/');
    expect(exclude).not.toContain('.mcp.json');
  });

  it('FR5 / D12: re-running `ok init` (no flag) on a local-only repo preserves the prior posture', async () => {
    await runInitForTest({ sharing: 'local-only' });
    // Same testDir, second run with no flag. Should stay local-only.
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('local-only');
  });

  it('AC11: a second `--local-only` is a no-op against the exclude file (alreadyPresent)', async () => {
    await runInitForTest({ sharing: 'local-only' });
    const before = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    const result = await runInitForTest({ sharing: 'local-only' });
    const after = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(after).toBe(before);
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.action).toBe('noop');
    expect(result.sharing.alreadyPresent.length).toBeGreaterThan(0);
  });

  it('an explicit `--shared` after a prior `--local-only` removes OK paths and leaves the rest byte-identical', async () => {
    // Seed: write user-authored lines into the exclude file, then unshare,
    // then re-share via explicit flag.
    await runInitForTest({ sharing: 'local-only' });
    // Inject a user line that must survive.
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    const before = readFileSync(excludePath, 'utf-8');
    const augmented = `# user header\n${before}*.tmp\n`;
    writeFileSync(excludePath, augmented, 'utf-8');

    await runInitForTest({ sharing: 'shared' });
    const after = readFileSync(excludePath, 'utf-8');
    expect(after).toContain('# user header');
    expect(after).toContain('*.tmp');
    expect(after).not.toContain('.ok/');
    expect(after).not.toContain('.mcp.json');
  });

  it('`--local-only` refuses when a teammate has committed `.mcp.json`, init still exits 0', async () => {
    // Seed: commit a .mcp.json so it's tracked upstream.
    await runInitForTest({ sharing: 'shared' }); // sets up .git
    writeFileSync(join(testDir, '.mcp.json'), '{}\n', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: testDir });
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'add mcp'], {
      cwd: testDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const result = await runInitForTest({ sharing: 'local-only' });
    expect(result.sharing.kind).toBe('refused-tracked');
    if (result.sharing.kind !== 'refused-tracked') throw new Error('expected refused-tracked');
    expect(result.sharing.tracked).toContain('.mcp.json');
    expect(result.sharing.remediation).toContain('git rm --cached .mcp.json');
    // No tracked content was modified; the .mcp.json file is still on disk.
    expect(existsSync(join(testDir, '.mcp.json'))).toBe(true);
  });

  it('TTY prompt fires only when no explicit flag is set', async () => {
    let promptedDefault: 'shared' | 'local-only' | null = null;
    await runInitForTest({
      sharing: 'shared',
      isTTY: true,
      sharingPromptFn: async (def) => {
        promptedDefault = def;
        return def;
      },
    });
    expect(promptedDefault).toBeNull(); // explicit flag wins; no prompt
  });

  it('TTY prompt receives `local-only` as the pre-selected default on a previously-local-only repo', async () => {
    await runInitForTest({ sharing: 'local-only' });
    let promptedDefault: 'shared' | 'local-only' | null = null;
    const result = await runInitForTest({
      isTTY: true,
      sharingPromptFn: async (def) => {
        promptedDefault = def;
        return def; // confirm the default
      },
    });
    expect(promptedDefault).toBe('local-only');
    expect(result.sharing.kind).toBe('applied');
  });
});

// ---------------------------------------------------------------------------
// resolveSharingMode precedence
// ---------------------------------------------------------------------------

describe('resolveSharingMode', () => {
  let testDir: string;
  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `resolve-sharing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('explicit flag beats everything', async () => {
    const mode = await resolveSharingMode({
      sharing: 'local-only',
      projectRoot: testDir,
      isTTY: true,
      promptFn: async () => 'shared',
    });
    expect(mode).toBe('local-only');
  });

  it('non-TTY without flag → returns readSharingMode (shared for fresh repo)', async () => {
    const mode = await resolveSharingMode({ projectRoot: testDir, isTTY: false });
    expect(mode).toBe('shared');
  });

  it('TTY without flag → invokes prompt with the readSharingMode seed', async () => {
    let seed: 'shared' | 'local-only' | null = null;
    const mode = await resolveSharingMode({
      projectRoot: testDir,
      isTTY: true,
      promptFn: async (s) => {
        seed = s;
        return 'local-only';
      },
    });
    expect(seed).toBe('shared');
    expect(mode).toBe('local-only');
  });
});

describe('resolveInitSkillEnablement — --skills / --no-skills flag parsing', () => {
  const sorted = (skills: string | boolean | undefined): string[] =>
    [...resolveInitSkillEnablement(skills)].sort();

  it('undefined (no flag) enables every user-global bundle', () => {
    expect(sorted(undefined)).toEqual(['discovery', 'write-skill']);
  });

  it('true (bare --skills) enables every bundle', () => {
    expect(sorted(true)).toEqual(['discovery', 'write-skill']);
  });

  it('false (--no-skills) enables none', () => {
    expect(sorted(false)).toEqual([]);
  });

  it('a comma list enables only the named bundles', () => {
    expect(sorted('discovery')).toEqual(['discovery']);
    expect(sorted('write-skill')).toEqual(['write-skill']);
    expect(sorted('discovery,write-skill')).toEqual(['discovery', 'write-skill']);
  });

  it('trims whitespace and drops unknown names', () => {
    expect(sorted(' discovery , write-skill ')).toEqual(['discovery', 'write-skill']);
    expect(sorted('discovery,bogus')).toEqual(['discovery']);
    expect(sorted('bogus')).toEqual([]);
  });
});
