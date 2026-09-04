import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveBundleEnabled } from '@inkeep/open-knowledge-core';
import { readBundleDecision } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from '../config/loader.ts';
import { OK_DIR } from '../constants.ts';
import { previewContent } from '../content/preview.ts';
import { buildPiExtensionSource } from '../integrations/pi-extension.ts';
import {
  ALL_EDITOR_IDS,
  CHAIN_V2,
  EDITOR_TARGETS,
  resolveClaudeCodeConfigPath,
  resolveClaudeDesktopConfigPath,
  resolveCodexConfigPath,
  resolveCopilotConfigPath,
  resolveCursorConfigPath,
  resolveLmStudioConfigPath,
  resolveOpenCodeConfigPath,
} from './editors.ts';

const PUBLISHED_CHAIN_ENTRY = { command: '/bin/sh', args: ['-l', '-c', CHAIN_V2] } as const;

import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../native/toml-config-engine.ts';
import {
  applySharingMode,
  buildInitJsonSummary,
  ContentDirError,
  classifyExistingMcpEntry,
  detectInstalledEditors,
  type EditorMcpResult,
  formatInitResult,
  formatSharingOutcome,
  HomeProjectRootError,
  initCommand,
  MANAGED_FILE_BUILDERS,
  readExistingMcpEntry,
  resolveInitSkillEnablement,
  resolveMcpScope,
  resolveRequestedContentDir,
  resolveSharingMode,
  runInit,
  writeEditorMcpConfig,
  writeUserMcpConfigs,
} from './init.ts';

const NATIVE_TOML_AVAILABLE = createTomlConfigEngine().backend === 'native';

describe('runInit', () => {
  let testDir: string;
  let fakeHome: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalArgv1 = process.argv[1];

  const claudeConfigPath = () => resolveClaudeCodeConfigPath({ home: fakeHome });
  const cursorConfigPath = () => resolveCursorConfigPath({ home: fakeHome });
  const codexConfigPath = () => resolveCodexConfigPath({ home: fakeHome, env: {} });
  const opencodeConfigPath = () => resolveOpenCodeConfigPath({ home: fakeHome, env: {} });
  const lmStudioConfigPath = () => resolveLmStudioConfigPath({ home: fakeHome });
  const devRepoRoot = () => join(testDir, 'local-open-knowledge');
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
  const defaultInstallUserSkill = async () => 'installed' as const;
  const runInitForTest = async (options: Parameters<typeof runInit>[0] = {}) =>
    runInit({
      cwd: testDir,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      skills: true,
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

  it('scaffolds .ok/ and writes a fresh global Claude config', async () => {
    const result = await runInitForTest();

    expect(result.contentCreated.length).toBeGreaterThan(0);
    expect(existsSync(join(testDir, OK_DIR, 'cache'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'local'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
    expect(existsSync(join(testDir, OK_DIR, 'articles'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'external-sources'))).toBe(false);
    expect(existsSync(join(testDir, OK_DIR, 'research'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codeium'))).toBe(false);

    expect(result.mcpAction).toBe('written');
    const mcpPath = claudeConfigPath();
    expect(existsSync(mcpPath)).toBe(true);

    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers[result.editors[0].serverName]).toEqual(PUBLISHED_CHAIN_ENTRY);

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

  it('preserves user-added fields while updating the managed launcher', async () => {
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
    expect(config.mcpServers['open-knowledge']).toEqual({
      ...PUBLISHED_CHAIN_ENTRY,
      cwd: testDir,
      env: { OK_MODE: 'local' },
    });
  });

  it('updates only the managed launcher when switching a published entry to dev mode', async () => {
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
    expect(config.mcpServers['open-knowledge']).toEqual({
      command: expectedDevMcpEntry().command,
      args: expectedDevMcpEntry().args,
    });
  });

  it('does not touch ~/.claude.json when --no-mcp is passed', async () => {
    const result = await runInitForTest({ mcp: false });

    expect(result.mcpAction).toBe('skipped-flag');
    expect(existsSync(claudeConfigPath())).toBe(false);

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
    expect(result.mcpAction).toBe('declined');
    expect(result.editors[0].action).toBe('declined');
    expect(result.editors[0].declineReason).toBe('unparseable');
    expect(readFileSync(claudeConfigPath(), 'utf-8')).toBe(original);

    const output = formatInitResult(result, testDir);
    expect(output).toContain('left unchanged (config not readable)');

    expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
  });

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
    const PUBLISHED_OPENCODE_ENTRY = {
      type: 'local',
      enabled: true,
      command: ['/bin/sh', '-l', '-c', CHAIN_V2],
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
      expect(result.projectSkills.some((s) => s.path === codexSkill)).toBe(true);
      expect(result.projectSkills.some((s) => s.path === opencodeSkill)).toBe(true);
      expect(existsSync(codexSkill)).toBe(true);
      expect(existsSync(opencodeSkill)).toBe(true);
      expect(existsSync(join(testDir, '.agents', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        false,
      );
    });
  });

  describe('Pi (project-scope file drop)', () => {
    const piBridgePath = () => join(testDir, '.pi', 'extensions', 'open-knowledge.ts');

    it('drops the managed bridge extension at .pi/extensions/open-knowledge.ts', async () => {
      const result = await runInitForTest({ editors: ['pi'], scope: 'project' });

      const projResult = result.editors.find(
        (e) => e.editorId === 'pi' && e.configScope === 'project',
      );
      expect(projResult?.action).toBe('written');
      expect(projResult?.configPath).toBe(piBridgePath());

      const bytes = readFileSync(piBridgePath(), 'utf-8');
      expect(bytes).toBe(buildPiExtensionSource({ mode: 'published' }));
    });

    it('re-run is idempotent — byte-identical bridge, action overwritten', async () => {
      await runInitForTest({ editors: ['pi'], scope: 'project' });
      const first = readFileSync(piBridgePath(), 'utf-8');

      const again = await runInitForTest({ editors: ['pi'], scope: 'project' });
      const projResult = again.editors.find(
        (e) => e.editorId === 'pi' && e.configScope === 'project',
      );
      expect(projResult?.action).toBe('overwritten');
      expect(readFileSync(piBridgePath(), 'utf-8')).toBe(first);
    });

    it('writes the Pi project skill into .pi/skills/', async () => {
      const result = await runInitForTest({ editors: ['pi'], scope: 'project' });
      const piSkill = join(testDir, '.pi', 'skills', 'open-knowledge', 'SKILL.md');
      expect(result.projectSkills.some((s) => s.path === piSkill)).toBe(true);
      expect(existsSync(piSkill)).toBe(true);
    });

    it('user scope produces NO pi result and never touches ~/.pi (project-scope-only editor)', async () => {
      mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true });
      const result = await runInitForTest({ editors: ['pi'], scope: 'user' });
      expect(result.editors.filter((e) => e.editorId === 'pi')).toHaveLength(0);
      expect(existsSync(join(fakeHome, '.pi', 'extensions'))).toBe(false);
    });

    it('every format:file target has a registered managed-file builder', () => {
      for (const target of Object.values(EDITOR_TARGETS)) {
        if (target.format === 'file') {
          expect(MANAGED_FILE_BUILDERS[target.id]).toBeDefined();
        }
      }
      expect(MANAGED_FILE_BUILDERS.pi).toBe(buildPiExtensionSource);
    });

    it('dev mode drops the dev-launcher bridge', async () => {
      enableDevMcp();
      await runInitForTest({ editors: ['pi'], scope: 'project', devMcp: true });
      const bytes = readFileSync(piBridgePath(), 'utf-8');
      expect(bytes).toBe(buildPiExtensionSource({ mode: 'dev' }));
      expect(bytes).toContain(join(devRepoRoot(), 'packages', 'cli', 'dist', 'cli.mjs'));
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
    it('omitted editors create project skills only for detected hosts', async () => {
      rmSync(join(fakeHome, '.claude'), { recursive: true, force: true });

      const noneDetected = await runInitForTest({ mcp: false });
      expect(noneDetected.projectSkills).toEqual([]);
      expect(existsSync(join(testDir, '.claude'))).toBe(false);
      expect(existsSync(join(testDir, '.cursor'))).toBe(false);
      expect(existsSync(join(testDir, '.agents'))).toBe(false);

      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      const claudeDetected = await runInitForTest({ mcp: false });
      expect(claudeDetected.projectSkills.map((skill) => skill.editorId)).toEqual(['claude']);
      expect(existsSync(join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
      expect(existsSync(join(testDir, '.cursor'))).toBe(false);
      expect(existsSync(join(testDir, '.agents'))).toBe(false);
    });

    it('explicit editors remain authoritative when their roots do not exist yet', async () => {
      rmSync(join(fakeHome, '.claude'), { recursive: true, force: true });

      const result = await runInitForTest({ editors: ['cursor'], mcp: false });

      expect(result.projectSkills.map((skill) => skill.editorId)).toEqual(['cursor']);
      expect(existsSync(join(testDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
      expect(existsSync(join(testDir, '.claude'))).toBe(false);
      expect(existsSync(join(testDir, '.agents'))).toBe(false);
    });

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
      mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
      mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
      mkdirSync(join(fakeHome, '.openclaw'), { recursive: true });
      mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true });
      mkdirSync(join(fakeHome, '.gemini'), { recursive: true });
      mkdirSync(dirname(lmStudioConfigPath()), { recursive: true });
      mkdirSync(join(fakeHome, '.hermes'), { recursive: true });

      const result = await runInitForTest({ editors: [...ALL_EDITOR_IDS] });

      expect(result.editors).toHaveLength(ALL_EDITOR_IDS.length - 1);
      expect(result.editors.map((e) => e.editorId)).not.toContain('pi');
      for (const editor of result.editors) {
        expect(editor.action).toBe('written');
      }

      expect(existsSync(claudeConfigPath())).toBe(true);
      expect(existsSync(resolveClaudeDesktopConfigPath({ home: fakeHome }))).toBe(true);
      expect(existsSync(cursorConfigPath())).toBe(true);
      expect(existsSync(codexConfigPath())).toBe(true);
      expect(existsSync(join(fakeHome, '.copilot', 'mcp-config.json'))).toBe(true);
      expect(existsSync(opencodeConfigPath())).toBe(true);
      expect(existsSync(lmStudioConfigPath())).toBe(true);
      const openclawConfig = JSON.parse(
        readFileSync(join(fakeHome, '.openclaw', 'openclaw.json'), 'utf-8'),
      );
      expect(openclawConfig.mcp.servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
      const antigravityConfig = JSON.parse(
        readFileSync(join(fakeHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'),
      );
      expect(antigravityConfig.mcpServers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
      const hermesConfig = parseYaml(
        readFileSync(join(fakeHome, '.hermes', 'config.yaml'), 'utf-8'),
      );
      expect(hermesConfig.mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
    });

    it('overwrites across all targeted editors', async () => {
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
  });

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

      await runInitForTest({ installUserSkill: async () => 'skip-current' });

      expect(readFileSync(claudePath, 'utf-8')).toBe(beforeClaude);
      expect(readFileSync(agentsPath, 'utf-8')).toBe(beforeAgents);
    });
  });

  describe('installUserSkill wiring', () => {
    it('returns skillInstall = "installed" when the install succeeds', async () => {
      const result = await runInitForTest({
        installUserSkill: async () => 'installed',
      });
      expect(result.skillInstall).toBe('installed');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('User-global skill:');
      expect(output).toContain('installed for');
      expect(output).not.toContain('detected agent hosts');
    });

    it('reports the hosts actually written, never an unverified claim (issue #820)', async () => {
      mkdirSync(join(fakeHome, '.claude'), { recursive: true });
      const result = await runInitForTest({
        installUserSkill: async () => 'installed',
      });
      expect(result.skillHosts).toEqual(['claude']);
      expect(formatInitResult(result, testDir)).toContain('installed for Claude');
    });

    it('returns skillInstall = "no-hosts" when no agent host is present', async () => {
      const result = await runInitForTest({
        installUserSkill: async () => 'no-hosts',
      });
      expect(result.skillInstall).toBe('no-hosts');
      expect(result.skillHosts).toEqual([]);
      const output = formatInitResult(result, testDir);
      expect(output).toContain('no supported agent host detected');
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
      expect(result.mcpAction).toBe('written');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('install failed');
      expect(output).toContain('ok repair-skills');
      expect(output).not.toContain('npx skills');
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

    it('an omitted skill choice installs the onboarding set, not every bundle', async () => {
      const installed: (string | undefined)[] = [];
      await runInitForTest({
        skills: undefined,
        installUserSkill: async (opts) => {
          installed.push(opts?.bundleId);
          return 'installed';
        },
      });
      expect([...installed].sort()).toEqual(['discovery']);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-write-skill')).toBeNull();
    });

    it('--no-skills installs nothing and records NOTHING', async () => {
      const installed: (string | undefined)[] = [];
      await runInitForTest({
        skills: false,
        installUserSkill: async (opts) => {
          installed.push(opts?.bundleId);
          return 'installed';
        },
      });
      expect(installed).toEqual([]);
      expect(await readBundleDecision(fakeHome, 'open-knowledge-discovery')).toBeNull();
      expect(await readBundleDecision(fakeHome, 'open-knowledge-write-skill')).toBeNull();
    });

    it('--no-skills leaves bundles another project already installed on disk', async () => {
      const central = join(fakeHome, '.agents', 'skills');
      for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
        mkdirSync(join(central, name), { recursive: true });
        writeFileSync(join(central, name, 'SKILL.md'), '# Installed earlier\n');
      }

      await runInitForTest({ skills: false, installUserSkill: async () => 'installed' });

      for (const name of ['open-knowledge-discovery', 'open-knowledge-write-skill']) {
        expect(existsSync(join(central, name, 'SKILL.md'))).toBe(true);
        expect(await readBundleDecision(fakeHome, name)).toBeNull();
      }
    });

    it('an unrecorded bundle grandfathers to disk, which is why recording nothing is correct', () => {
      expect(resolveBundleEnabled(null, { installedOnDisk: false })).toBe(false);
      expect(resolveBundleEnabled(null, { installedOnDisk: true })).toBe(true);
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
      expect(await readBundleDecision(fakeHome, 'open-knowledge-write-skill')).toBeNull();
    });

    it('installs every enabled bundle with force so the shared cli-hosts version key cannot skip the second', async () => {
      const forced: (boolean | undefined)[] = [];
      await runInitForTest({
        skills: 'discovery,write-skill',
        installUserSkill: async (opts) => {
          forced.push(opts?.force);
          return 'installed';
        },
      });
      expect(forced).toEqual([true, true]);
    });

    it('--no-skills reports declined, not a false "already installed"', async () => {
      const result = await runInitForTest({
        skills: false,
        installUserSkill: async () => 'installed',
      });
      expect(result.skillInstall).toBe('declined');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('skipped for this run');
      expect(output).not.toContain('for this project');
      expect(output).not.toContain('machine-wide choice');
      expect(output).not.toContain('stay off for every project');
      expect(output).not.toContain('already installed at current version');
    });

    it('surfaces the manual-install hint when one bundle fails even if the other installs', async () => {
      const result = await runInitForTest({
        skills: 'discovery,write-skill',
        installUserSkill: async (opts) =>
          opts?.bundleId === 'write-skill' ? 'failed' : 'installed',
      });
      expect(result.skillInstall).toBe('failed');
      const output = formatInitResult(result, testDir);
      expect(output).toContain('install failed');
    });
  });

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

  describe('ensureProjectGit wiring (US-005)', () => {
    it('fresh tmpdir (no .git/) → runInit creates .git/ and reports didGitInit=true', async () => {
      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(existsSync(join(testDir, '.git/HEAD'))).toBe(true);
      const head = readFileSync(join(testDir, '.git/HEAD'), 'utf-8');
      expect(head).toBe('ref: refs/heads/main\n');

      const output = formatInitResult(result, testDir);
      expect(output).toContain(`Initialized git repo at ${testDir}/.git/ (default branch: main)`);
    });

    it('pre-existing .git/HEAD → runInit does not re-init and reports didGitInit=false', async () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.git/HEAD'), 'ref: refs/heads/main\n');

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(false);
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Initialized git repo at');
    });

    it('fresh tmpdir → also seeds project-root .gitignore with .DS_Store', async () => {
      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(true);
      const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.DS_Store');

      const output = formatInitResult(result, testDir);
      expect(output).toContain(`Seeded .gitignore at ${testDir}/.gitignore (.DS_Store)`);
    });

    it('pre-existing .git/ → preserves a hand-authored .gitignore but appends the always-excluded project-skill block', async () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.git/HEAD'), 'ref: refs/heads/main\n');
      const original = '# user-authored\nnode_modules/\n';
      writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(false);
      expect(result.rootGitignoreCreated).toBe(false);
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Seeded .gitignore');
      const after = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(after.startsWith(original)).toBe(true);
      expect(after).toContain('.claude/skills/open-knowledge/');
      expect(after).toContain('.pi/skills/open-knowledge/');
    });

    it('fresh tmpdir WITH a pre-existing .gitignore → .DS_Store seed skipped, project-skill block appended', async () => {
      const original = 'secrets.env\n';
      writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(false);
      const after = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(after.startsWith(original)).toBe(true);
      expect(after).toContain('.claude/skills/open-knowledge/');
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Seeded .gitignore');
    });

    it('symlink at .gitignore → seed helper throws but runInit completes (non-fatal contract)', async () => {
      const sentinel = join(testDir, 'sentinel.txt');
      writeFileSync(sentinel, 'do-not-clobber', 'utf-8');
      symlinkSync(sentinel, join(testDir, '.gitignore'));

      const result = await runInitForTest({ editors: ['claude'] });

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(false);
      expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
      expect(readFileSync(sentinel, 'utf-8')).toBe('do-not-clobber');
    });

    it('git unusable everywhere → runInit surfaces the recoverable GitNotAvailableError (no content scaffolded)', async () => {
      const originalPath = process.env.PATH;
      const originalPlatform = process.platform;
      process.env.PATH = '/nonexistent';
      Object.defineProperty(process, 'platform', {
        value: originalPlatform === 'win32' ? 'linux' : 'win32',
        configurable: true,
      });
      try {
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

      expect(existsSync(join(testDir, OK_DIR))).toBe(false);
      expect(existsSync(join(testDir, '.git'))).toBe(false);
    });
  });

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
      const result = await runInitForTest({ editors: ['claude'], scope: 'user' });
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(false);
      const claudeSkill = result.projectSkills.find((s) => s.editorId === 'claude');
      expect(claudeSkill?.action).toBe('written');
      expect(existsSync(join(testDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('wires Copilot’s user-global MCP config and project-local GitHub skill', async () => {
      mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
      const result = await runInitForTest({ editors: ['copilot'], scope: 'user' });

      expect(result.editors).toEqual([
        expect.objectContaining({
          editorId: 'copilot',
          action: 'written',
          configPath: join(fakeHome, '.copilot', 'mcp-config.json'),
        }),
      ]);
      expect(existsSync(join(fakeHome, '.copilot', 'mcp-config.json'))).toBe(true);
      expect(existsSync(join(testDir, '.mcp.json'))).toBe(false);
      expect(result.projectSkills).toContainEqual(
        expect.objectContaining({
          editorId: 'copilot',
          action: 'written',
          path: join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'),
        }),
      );
    });

    it('includes Copilot’s project skill in the default detected-editor run', async () => {
      mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
      const result = await runInitForTest({ scope: 'user' });

      expect(result.projectSkills).toContainEqual(
        expect.objectContaining({
          editorId: 'copilot',
          action: 'written',
          path: join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'),
        }),
      );
    });

    it('does not install Copilot’s project skill when its MCP config is skipped', async () => {
      const result = await runInitForTest({ editors: ['copilot'], mcp: false });

      expect(result.editors[0]).toMatchObject({
        editorId: 'copilot',
        action: 'skipped-flag',
      });
      expect(result.projectSkills).toContainEqual(
        expect.objectContaining({
          editorId: 'copilot',
          action: 'skipped-prerequisite',
        }),
      );
      expect(existsSync(join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        false,
      );
    });

    it('installs Copilot’s project skill with custom pre-existing MCP wiring', async () => {
      mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.copilot', 'mcp-config.json'),
        JSON.stringify({
          mcpServers: {
            'open-knowledge': { command: 'custom-ok', args: ['mcp'] },
          },
        }),
      );

      const result = await runInitForTest({ editors: ['copilot'], mcp: false });

      expect(result.projectSkills).toContainEqual(
        expect.objectContaining({ editorId: 'copilot', action: 'written' }),
      );
      expect(existsSync(join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        true,
      );
    });

    it('does not install Copilot’s project skill when its MCP config write is declined', async () => {
      mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
      writeFileSync(join(fakeHome, '.copilot', 'mcp-config.json'), '{ "mcpServers": ');

      const result = await runInitForTest({ editors: ['copilot'], scope: 'user' });

      expect(result.editors[0]).toMatchObject({
        editorId: 'copilot',
        action: 'declined',
      });
      expect(result.projectSkills).toContainEqual(
        expect.objectContaining({
          editorId: 'copilot',
          action: 'skipped-prerequisite',
        }),
      );
      expect(existsSync(join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        false,
      );
    });

    it('scope=project writes only project-level config for Claude', async () => {
      const result = await runInitForTest({ editors: ['claude'], scope: 'project' });
      expect(result.editors).toHaveLength(1);
      expect(result.editors[0].editorId).toBe('claude');
      expect(result.editors[0].action).toBe('written');
      expect(result.editors[0].configScope).toBe('project');
      expect(result.editors[0].configPath).toBe(join(testDir, '.mcp.json'));
      expect(existsSync(claudeConfigPath())).toBe(false);
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
      expect(result.editors).toHaveLength(0);
    });

    it('scope=project skips Copilot’s skill because it cannot establish MCP wiring', async () => {
      const result = await runInitForTest({ editors: ['copilot'], scope: 'project' });

      expect(result.editors).toHaveLength(0);
      expect(result.projectSkills).toContainEqual(
        expect.objectContaining({
          editorId: 'copilot',
          action: 'skipped-prerequisite',
          path: join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'),
        }),
      );
      expect(existsSync(join(testDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
        false,
      );
      expect(formatInitResult(result, testDir)).not.toContain(
        'GitHub Copilot does not support project-level config; skipped',
      );
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
      const nextStepsLine = output.split('\n').find((l) => l.includes('Open your editor'));
      expect(nextStepsLine).toBeDefined();
      const matches = nextStepsLine?.match(/Claude/g);
      expect(matches).toHaveLength(1);
    });

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
    const repo = join(fakeHome, 'repo');
    const sub = join(repo, 'sub');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    expect(existsSync(join(repo, '.git'))).toBe(true);

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    expect(result.projectRoot).toBe(repo);
    expect(existsSync(join(repo, OK_DIR))).toBe(true);
    expect(existsSync(join(sub, OK_DIR))).toBe(false);
    expect(result.gitRootPromoted).toBe(true);
    expect(result.promotedFromDir).toBe('sub');
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
    expect(result.gitRootPromoted).toBe(false);
    expect(result.promotedFromDir).toBeUndefined();
    const output = formatInitResult(result, result.projectRoot);
    expect(output).not.toContain('Content scope promoted to the git repo root');
  });

  it('loadConfig succeeds when called against the resolved projectRoot', async () => {
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
    expect(existsSync(join(repo, OK_DIR, 'config.yml'))).toBe(true);
    const { config: rootConfig } = loadConfig(result.projectRoot);
    expect(rootConfig).toBeDefined();
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

    expect(result.projectRoot).toBe(repo);
    expect(result.gitRootPromoted).toBe(true);
    expect(result.contentDir).toBe('notes');
    const { config } = loadConfig(result.projectRoot);
    expect(config.content.dir).toBe('notes');

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
    expect(existsSync(join(repo, OK_DIR))).toBe(false);
  });

  it('--content-dir on re-init is ignored (config.yml already exists) and warns', async () => {
    const repo = join(fakeHome, 'repo-cd-reinit');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });

    await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });
    expect(loadConfig(repo).config.content.dir).toBe('.');

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
    expect(
      buildInitJsonSummary(result, { contentDir: '.', contentFileCount: null }).contentDirApplied,
    ).toBe(false);
  });

  it('does not claim "config.yml already exists" when content scaffolding failed', async () => {
    const repo = join(fakeHome, 'repo-scaffold-fail');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    const base = await runInit({
      cwd: repo,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
    });

    const scaffoldFailed = {
      ...base,
      contentDirRequested: 'notes',
      contentDir: undefined,
      contentScaffoldFailed: true,
    };
    expect(formatInitResult(scaffoldFailed, base.projectRoot)).not.toContain('ignored');

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
    expect(summary.previewError).toBeNull();
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

describe('runInit — refuses the home directory as a project root', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const originalPlatform = process.platform;
  const defaultInstallUserSkill = async () => 'installed' as const;

  beforeEach(() => {
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'init-home-refusal-test-')));
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  const runAtHome = (cwd: string) =>
    runInit({
      cwd,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'project',
      skills: true,
    });

  it('throws HomeProjectRootError instead of setting up a project', async () => {
    await expect(runAtHome(fakeHome)).rejects.toBeInstanceOf(HomeProjectRootError);
  });

  it('writes nothing at all — no git repo, no .ok/, no project skills', async () => {
    await expect(runAtHome(fakeHome)).rejects.toThrow();

    expect(existsSync(join(fakeHome, '.git'))).toBe(false);
    expect(existsSync(join(fakeHome, OK_DIR))).toBe(false);
    expect(existsSync(join(fakeHome, '.okignore'))).toBe(false);
    for (const hostDir of ['.claude', '.cursor', '.codex']) {
      expect(existsSync(join(fakeHome, hostDir, 'skills', 'open-knowledge'))).toBe(false);
    }
    expect(existsSync(join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codex', 'config.toml'))).toBe(false);
  });

  it('refuses a symlinked spelling of home too', async () => {
    const linkedHome = join(testDir, 'home-link');
    symlinkSync(fakeHome, linkedHome);

    await expect(runAtHome(linkedHome)).rejects.toBeInstanceOf(HomeProjectRootError);
    expect(existsSync(join(fakeHome, '.git'))).toBe(false);
  });

  it('the command action prints the refusal and exits 64 rather than throwing', async () => {
    const savedCwd = process.cwd();
    const savedExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.chdir(fakeHome);

      await initCommand().parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(64);
      const printed = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(printed).toContain(
        'Refusing to set up an OpenKnowledge project in your home directory',
      );
      expect(printed).not.toContain('at runInit');
    } finally {
      process.chdir(savedCwd);
      process.exitCode = savedExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('still initializes a folder inside home', async () => {
    const project = join(fakeHome, 'notes');
    mkdirSync(project, { recursive: true });

    const result = await runInit({
      cwd: project,
      home: fakeHome,
      installUserSkill: defaultInstallUserSkill,
      scope: 'user',
      skills: true,
    });

    expect(result.projectRoot).toBe(project);
    expect(existsSync(join(project, OK_DIR, 'config.yml'))).toBe(true);
  });
});

describe('resolveRequestedContentDir', () => {
  let root: string;
  beforeEach(() => {
    const raw = join(tmpdir(), `rrcd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
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
    expect(resolveRequestedContentDir('sub', root, root)).toBe('sub');
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
    const linkParent = join(
      tmpdir(),
      `rrcd-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    symlinkSync(root, linkParent);
    try {
      expect(resolveRequestedContentDir('.', root, linkParent)).toBe('.');
      expect(resolveRequestedContentDir('sub', root, linkParent)).toBe('sub');
    } finally {
      unlinkSync(linkParent);
    }
  });
});

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

describe('initCommand', () => {
  it('rejects --scope with an invalid value (non-zero exit)', () => {
    const cmd = initCommand();
    cmd.exitOverride();
    expect(() => cmd.parse(['--scope', 'bogus'], { from: 'user' })).toThrow();
  });
});

describe('detectInstalledEditors', () => {
  let testDir: string;
  let fakeHome: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalCopilotHome = process.env.COPILOT_HOME;

  const cursorConfigPath = () => resolveCursorConfigPath({ home: fakeHome });
  const codexConfigPath = () => resolveCodexConfigPath({ home: fakeHome, env: {} });
  const opencodeConfigPath = () => resolveOpenCodeConfigPath({ home: fakeHome, env: {} });
  const lmStudioConfigPath = () => resolveLmStudioConfigPath({ home: fakeHome });

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
    delete process.env.COPILOT_HOME;
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
    if (originalCopilotHome === undefined) {
      delete process.env.COPILOT_HOME;
    } else {
      process.env.COPILOT_HOME = originalCopilotHome;
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

  it('detects Antigravity when ~/.gemini exists', async () => {
    mkdirSync(join(fakeHome, '.gemini'), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toContain('antigravity');
  });

  it('does NOT detect Antigravity when ~/.gemini is absent', async () => {
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).not.toContain('antigravity');
  });

  it('detects Codex when ~/.codex/ exists', async () => {
    mkdirSync(dirname(codexConfigPath()), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toContain('codex');
  });

  it('detects Copilot when ~/.copilot exists', async () => {
    mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
    expect(detectInstalledEditors(testDir, fakeHome)).toContain('copilot');
  });

  it('does NOT detect Copilot when ~/.copilot is absent', async () => {
    expect(detectInstalledEditors(testDir, fakeHome)).not.toContain('copilot');
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
    mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
    mkdirSync(dirname(opencodeConfigPath()), { recursive: true });
    mkdirSync(join(fakeHome, '.openclaw'), { recursive: true });
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true });
    mkdirSync(join(fakeHome, '.gemini'), { recursive: true });
    mkdirSync(dirname(lmStudioConfigPath()), { recursive: true });
    mkdirSync(join(fakeHome, '.hermes'), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toEqual(expect.arrayContaining([...ALL_EDITOR_IDS]));
    expect(detected).toHaveLength(ALL_EDITOR_IDS.length);
  });

  it('detects Pi via ~/.pi/agent (not the bare ~/.pi dotdir)', async () => {
    mkdirSync(join(fakeHome, '.pi'), { recursive: true });
    expect(detectInstalledEditors(testDir, fakeHome)).not.toContain('pi');
    mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true });
    expect(detectInstalledEditors(testDir, fakeHome)).toContain('pi');
  });

  it('preserves EDITOR_TARGETS ordering in return value', async () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(dirname(resolveClaudeDesktopConfigPath({ home: fakeHome })), { recursive: true });
    mkdirSync(dirname(cursorConfigPath()), { recursive: true });
    mkdirSync(dirname(codexConfigPath()), { recursive: true });
    const detected = detectInstalledEditors(testDir, fakeHome);
    expect(detected).toEqual(['claude', 'claude-desktop', 'cursor', 'codex']);
  });

  it('returns empty list when the cwd itself does not exist (zero-detected edge case)', () => {
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
    mkdirSync(dirname(resolveCursorConfigPath({ home: fakeHome })), { recursive: true });

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
    writeFileSync(claudePath, '   \n');

    const results: EditorMcpResult[] = await writeUserMcpConfigs({
      editors: ['claude'],
      home: fakeHome,
    });
    expect(results[0]?.action).toBe('written');

    const config = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(config.mcpServers['open-knowledge']).toEqual(CANONICAL);

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
    setTomlConfigEngineForTesting(createTomlConfigEngine(() => null));
  });

  afterEach(() => {
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
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const original = '{ "mcpServers": [ deliberately malformed\n';
    writeFileSync(path, original, 'utf-8');

    const result = classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome);

    expect(result.kind).toBe('decline');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(readExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toBeNull();
  });

  it('no-entry on a JSONC config with // and block comments (not unparseable)', () => {
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
    const path = resolveOpenCodeConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ "mcp": { "a": {} }, "mcp": { "b": {} } }', 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.opencode, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'duplicate-container',
    });
  });

  it('no-entry (not duplicate-container) when only an unrelated sibling key repeats', () => {
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
    const path = resolveCursorConfigPath({ home: fakeHome });
    mkdirSync(dirname(path), { recursive: true });
    const oversized = `{ "mcpServers": {}, "_history": "${'x'.repeat(11 * 1024 * 1024)}" }`;
    writeFileSync(path, oversized, 'utf-8');
    expect(classifyExistingMcpEntry(EDITOR_TARGETS.cursor, '', fakeHome)).toEqual({
      kind: 'decline',
      reason: 'oversize',
    });
    expect(readFileSync(path, 'utf-8')).toBe(oversized);
  });
});

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

  it('formatSharingOutcome reports a drain that rode along with appends', () => {
    const out = formatSharingOutcome(
      {
        kind: 'applied',
        mode: 'local-only',
        action: 'added',
        appended: ['.mcp.json', '.cursor/mcp.json'],
        alreadyPresent: ['.ok/'],
        removed: ['.claude/skills/trip-log/'],
      },
      '/tmp/project',
    ).join('\n');
    expect(out).toMatch(/appended 2 path\(s\)/);
    expect(out).toMatch(/\.claude\/skills\/trip-log\//);
    expect(out).toMatch(/stale entry/);
    expect(out).not.toMatch(/nothing to do/);
  });

  it('formatSharingOutcome reports a drain-only pass without claiming a no-op', () => {
    const out = formatSharingOutcome(
      {
        kind: 'applied',
        mode: 'local-only',
        action: 'cleaned',
        appended: [],
        alreadyPresent: ['.ok/', '.okignore'],
        removed: ['.claude/skills/trip-log/'],
      },
      '/tmp/project',
    ).join('\n');
    expect(out).toMatch(/cleared 1 stale entry/);
    expect(out).not.toMatch(/nothing to do/);
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

  it('`ok init` (no flag, non-TTY) on a fresh repo defaults to local-only, matching the desktop dialogs', async () => {
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('local-only');
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.ok/');
    expect(exclude).toContain('.mcp.json');
  });

  it('re-running `ok init` (no flag) on an initialized shared repo stays shared', async () => {
    await runInitForTest({ sharing: 'shared' });
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('shared');
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).not.toContain('.mcp.json');
  });

  it('FR5 / D12: re-running `ok init` (no flag) on a local-only repo preserves the prior posture', async () => {
    await runInitForTest({ sharing: 'local-only' });
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
    await runInitForTest({ sharing: 'local-only' });
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
    await runInitForTest({ sharing: 'shared' });
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
    expect(promptedDefault).toBeNull();
  });

  it('TTY prompt receives `local-only` as the pre-selected default on a previously-local-only repo', async () => {
    await runInitForTest({ sharing: 'local-only' });
    let promptedDefault: 'shared' | 'local-only' | null = null;
    const result = await runInitForTest({
      isTTY: true,
      sharingPromptFn: async (def) => {
        promptedDefault = def;
        return def;
      },
    });
    expect(promptedDefault).toBe('local-only');
    expect(result.sharing.kind).toBe('applied');
  });
});

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

  it('non-TTY without flag on an already-initialized project → preserves shared', async () => {
    const mode = await resolveSharingMode({ projectRoot: testDir, isTTY: false });
    expect(mode).toBe('shared');
  });

  it('non-TTY without flag on a fresh project → local-only, matching the dialogs', async () => {
    const mode = await resolveSharingMode({
      projectRoot: testDir,
      isTTY: false,
      freshProject: true,
    });
    expect(mode).toBe('local-only');
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

  it('undefined (no flag) enables the onboarding set only', () => {
    expect(sorted(undefined)).toEqual(['discovery']);
  });

  it('true (bare --skills) enables the onboarding set only', () => {
    expect(sorted(true)).toEqual(['discovery']);
  });

  it('write-skill is still one flag away', () => {
    expect(sorted('discovery,write-skill')).toEqual(['discovery', 'write-skill']);
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

describe('consent bypass never fabricates its own detection evidence (PRD-8007)', () => {
  let fakeHome: string;
  let testDir: string;
  const originalPlatform = process.platform;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `mcp-fabricated-detection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  const SELF_PROBING = [
    ['cursor', resolveCursorConfigPath],
    ['codex', resolveCodexConfigPath],
    ['claude-desktop', resolveClaudeDesktopConfigPath],
    ['opencode', resolveOpenCodeConfigPath],
    ['copilot', resolveCopilotConfigPath],
  ] as const;

  for (const [editorId, resolvePath] of SELF_PROBING) {
    it(`${editorId}: an explicit tick on an absent tool writes nothing`, () => {
      const configPath = resolvePath({ home: fakeHome });
      expect(existsSync(dirname(configPath))).toBe(false);

      const result = writeEditorMcpConfig(
        EDITOR_TARGETS[editorId],
        '',
        { skipAvailabilityCheck: true },
        fakeHome,
      );

      expect(result.action).toBe('skipped-missing');
      expect(existsSync(dirname(configPath))).toBe(false);
      expect(detectInstalledEditors('', fakeHome)).not.toContain(editorId);
    });

    it(`${editorId}: the tick is still honoured once the tool is really there`, () => {
      const configPath = resolvePath({ home: fakeHome });
      mkdirSync(dirname(configPath), { recursive: true });

      const result = writeEditorMcpConfig(
        EDITOR_TARGETS[editorId],
        '',
        { skipAvailabilityCheck: true },
        fakeHome,
      );

      expect(result.action).toBe('written');
      expect(existsSync(configPath)).toBe(true);
    });
  }

  it('refuses when the probe is an ANCESTOR of the config dir, not just equal to it', () => {
    const probeRoot = join(fakeHome, '.synthetic-probe');
    const syntheticTarget = {
      ...EDITOR_TARGETS.cursor,
      id: 'synthetic' as (typeof EDITOR_TARGETS.cursor)['id'],
      configPath: () => join(probeRoot, 'config', 'mcp_config.json'),
      detectPath: () => probeRoot,
    };
    expect(existsSync(probeRoot)).toBe(false);

    const refused = writeEditorMcpConfig(
      syntheticTarget,
      '',
      { skipAvailabilityCheck: true },
      fakeHome,
    );

    expect(refused.action).toBe('skipped-missing');
    expect(existsSync(probeRoot)).toBe(false);

    mkdirSync(probeRoot, { recursive: true });
    const written = writeEditorMcpConfig(
      syntheticTarget,
      '',
      { skipAvailabilityCheck: true },
      fakeHome,
    );
    expect(written.action).toBe('written');
    expect(existsSync(join(probeRoot, 'config', 'mcp_config.json'))).toBe(true);
  });

  it('Claude Code keeps the bypass — its config sits beside the probe, not inside it', () => {
    const configPath = resolveClaudeCodeConfigPath({ home: fakeHome });
    expect(existsSync(join(fakeHome, '.claude'))).toBe(false);

    const result = writeEditorMcpConfig(
      EDITOR_TARGETS.claude,
      '',
      { skipAvailabilityCheck: true },
      fakeHome,
    );

    expect(result.action).toBe('written');
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(fakeHome, '.claude'))).toBe(false);
  });

  it('the whole consent write leaves an empty home empty apart from Claude Code', async () => {
    const results: EditorMcpResult[] = await writeUserMcpConfigs({
      editors: ['claude', 'cursor', 'codex', 'claude-desktop', 'opencode', 'copilot'],
      home: fakeHome,
    });

    expect(results.filter((r) => r.action === 'written').map((r) => r.editorId)).toEqual([
      'claude',
    ]);
    expect(
      results
        .filter((r) => r.action === 'skipped-missing')
        .map((r) => r.editorId)
        .sort(),
    ).toEqual(['claude-desktop', 'codex', 'copilot', 'cursor', 'opencode']);
    expect(detectInstalledEditors('', fakeHome)).not.toContain('cursor');
    expect(detectInstalledEditors('', fakeHome)).not.toContain('codex');
  });
});
