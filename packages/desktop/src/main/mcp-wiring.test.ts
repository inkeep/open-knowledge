import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  unlinkSync as fsUnlinkSync,
  writeFileSync as fsWriteFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildManagedServerEntry,
  classifyExistingMcpEntry,
  type EditorMcpTarget,
  type McpEntryClassification,
} from '@inkeep/open-knowledge';
import { afterEach, describe, expect, test } from 'vitest';
import { classifyExistingMcpEntry as classifyWithOverridableEngine } from '../../../cli/src/commands/init.ts';
import {
  createTomlConfigEngine,
  setTomlConfigEngineForTesting,
} from '../../../cli/src/native/toml-config-engine.ts';
import type { McpWiringEditorId } from '../shared/ipc-channels.ts';
import {
  checkAndRepairMcpWiringOnStartup,
  type McpStatusMarker,
  type McpWiringCliSurface,
  type McpWiringDispatchTarget,
  type McpWiringFsOps,
  type McpWiringPathInstallSurface,
  type McpWiringSkillsSurface,
  readMcpStatusMarker,
  runMcpWiringOnFirstLaunch,
  writeMcpStatusMarker,
} from './mcp-wiring.ts';

const NATIVE_TOML_AVAILABLE = createTomlConfigEngine().backend === 'native';

function memoryFs(
  initial: Record<string, string> = {},
): McpWiringFsOps & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => files[path] ?? '',
    writeFileSync: (path, content) => {
      files[path] = content;
    },
    mkdirSync: () => {},
    renameSync: (from, to) => {
      files[to] = files[from] ?? '';
      delete files[from];
    },
    unlinkSync: (path) => {
      delete files[path];
    },
  };
}

const PACKAGED_EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

function fakeTarget(id: McpWiringEditorId): EditorMcpTarget {
  return {
    id,
    label: id,
    format: 'json',
    topLevelKey: 'mcpServers',
    serverName: () => 'open-knowledge',
    configPath: (_cwd, home) => `${home}/.config-for-${id}.json`,
    buildEntry: () => buildManagedServerEntry({ mode: 'published' }),
    scope: 'global',
  };
}

interface BuildStartupCliOptions {
  classify: McpEntryClassification;
  writeOutcome?: 'written' | 'overwritten' | 'failed' | 'declined';
  writeError?: string;
}

function buildStartupCli(opts: BuildStartupCliOptions): {
  cli: McpWiringCliSurface;
  events: Array<Record<string, unknown>>;
  order: string[];
} {
  const events: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const target = fakeTarget('claude' as McpWiringEditorId);
  const cli: McpWiringCliSurface = {
    detectInstalledEditors: () => ['claude' as McpWiringEditorId],
    classifyExistingMcpEntry: () => opts.classify,
    readExistingMcpEntry: () => (opts.classify.kind === 'present' ? opts.classify.entry : null),
    allEditorIds: ['claude' as McpWiringEditorId],
    editorTargets: { claude: target } as Record<McpWiringEditorId, EditorMcpTarget>,
    writeUserMcpConfigs: async ({ editors }) => {
      order.push('write');
      return editors.map((editorId) => ({
        editorId,
        label: editorId,
        action: opts.writeOutcome ?? 'overwritten',
        configPath: target.configPath('', '/home'),
        serverName: 'open-knowledge',
        ...(opts.writeError ? { error: opts.writeError } : {}),
      }));
    },
  };
  return { cli, events, order };
}

describe('checkAndRepairMcpWiringOnStartup — migrate event ordering', () => {
  test('legacy entry → mcp-config-migrate fires before the write', async () => {
    const { cli, events, order } = buildStartupCli({
      classify: {
        kind: 'present',
        entry: { command: 'npx', args: ['-y', '@inkeep/open-knowledge', 'mcp'] },
      },
    });
    const result = await checkAndRepairMcpWiringOnStartup({
      isPackaged: true,
      executablePath: PACKAGED_EXE,
      home: '/home',
      platform: 'darwin',
      ipcMain: { handle() {}, removeHandler() {} } as unknown as Parameters<
        typeof checkAndRepairMcpWiringOnStartup
      >[0]['ipcMain'],
      cli,
      logger: {
        info() {},
        warn() {},
        error() {},
        event: (e) => {
          if (e.event === 'mcp-config-migrate') order.push('migrate-event');
          events.push(e);
        },
      },
    });
    expect(result.status).toBe('repaired');
    expect(order).toEqual(['migrate-event', 'write']);
    const migrate = events.find((e) => e.event === 'mcp-config-migrate');
    expect(migrate).toMatchObject({
      event: 'mcp-config-migrate',
      scope: 'user',
      surface: 'desktop-startup',
      editorId: 'claude',
      configPath: '/home/.config-for-claude.json',
      priorCommand: 'npx',
      priorArgs: ['-y', '@inkeep/open-knowledge', 'mcp'],
    });
  });

  test('canonical chain entry → no migrate event, no write', async () => {
    const { cli, events, order } = buildStartupCli({
      classify: {
        kind: 'present',
        entry: buildManagedServerEntry({ mode: 'published' }),
      },
    });
    const result = await checkAndRepairMcpWiringOnStartup({
      isPackaged: true,
      executablePath: PACKAGED_EXE,
      home: '/home',
      platform: 'darwin',
      ipcMain: { handle() {}, removeHandler() {} } as unknown as Parameters<
        typeof checkAndRepairMcpWiringOnStartup
      >[0]['ipcMain'],
      cli,
      logger: {
        info() {},
        warn() {},
        error() {},
        event: (e) => events.push(e),
      },
    });
    expect(result.status).toBe('ok');
    expect(order).toEqual([]);
    expect(events.some((e) => e.event === 'mcp-config-migrate')).toBe(false);
  });

  test('recognized future chain entry → no downgrade and no write', async () => {
    const futureEntry = {
      command: '/bin/sh',
      args: ['-l', '-c', '# ok-mcp-v99\nexit 127'],
    };
    const { cli, events, order } = buildStartupCli({
      classify: { kind: 'present', entry: futureEntry },
    });

    const result = await checkAndRepairMcpWiringOnStartup({
      isPackaged: true,
      executablePath: PACKAGED_EXE,
      home: '/home',
      platform: 'darwin',
      ipcMain: { handle() {}, removeHandler() {} } as unknown as Parameters<
        typeof checkAndRepairMcpWiringOnStartup
      >[0]['ipcMain'],
      cli,
      logger: {
        info() {},
        warn() {},
        error() {},
        event: (e) => events.push(e),
      },
    });

    expect(result.status).toBe('ok');
    expect(order).toEqual([]);
    expect(events).toContainEqual({ event: 'mcp-wiring-repair-healthy-current', editor: 'claude' });
    expect(events.some((e) => e.event === 'mcp-config-migrate')).toBe(false);
  });
});

describe('checkAndRepairMcpWiringOnStartup — non-destructive decline', () => {
  const inertIpcMain = { handle() {}, removeHandler() {} } as unknown as Parameters<
    typeof checkAndRepairMcpWiringOnStartup
  >[0]['ipcMain'];

  test('declined config → no write, no rename, ok status, bounded decline signal', async () => {
    const { cli, order } = buildStartupCli({
      classify: { kind: 'decline', reason: 'unparseable' },
    });
    const fs = memoryFs({ '/home/.config-for-claude.json': 'not-valid-json{' });
    const events: Array<Record<string, unknown>> = [];
    const result = await checkAndRepairMcpWiringOnStartup({
      isPackaged: true,
      executablePath: PACKAGED_EXE,
      home: '/home',
      platform: 'darwin',
      ipcMain: inertIpcMain,
      cli,
      fs,
      logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
    });
    expect(result.status).toBe('ok');
    expect(order).toEqual([]);
    expect(fs.files['/home/.config-for-claude.json']).toBe('not-valid-json{');
    expect(Object.keys(fs.files).some((p) => p.includes('.broken-'))).toBe(false);
    const decline = events.find((e) => e.event === 'mcp-config-decline');
    expect(decline).toMatchObject({
      event: 'mcp-config-decline',
      scope: 'user',
      surface: 'desktop-startup',
      editorId: 'claude',
      reason: 'unparseable',
    });
    expect(decline).not.toHaveProperty('configPath');
  });

  test('a write that declines (read-then-write race) is not counted as repaired', async () => {
    const { cli } = buildStartupCli({
      classify: {
        kind: 'present',
        entry: { command: 'npx', args: ['-y', '@inkeep/open-knowledge', 'mcp'] },
      },
      writeOutcome: 'declined',
    });
    const result = await checkAndRepairMcpWiringOnStartup({
      isPackaged: true,
      executablePath: PACKAGED_EXE,
      home: '/home',
      platform: 'darwin',
      ipcMain: inertIpcMain,
      cli,
      logger: { info() {}, warn() {}, error() {}, event() {} },
    });
    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('repairedEditors');
  });

  describe('reset-repro — a valid i64 Codex config is never reset', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    test.skipIf(!NATIVE_TOML_AVAILABLE)(
      'real classify on a 2^53+ integer TOML → byte-unchanged, no .broken, no-op',
      async () => {
        dir = mkdtempSync(join(tmpdir(), 'ok-reset-repro-'));
        const tomlPath = join(dir, 'config.toml');
        const original = [
          '# my codex config — keep my comments!',
          'model = "gpt-5"',
          '',
          '[mcp_servers.other]',
          'command = "node"',
          'startup_timeout_ms = 9223372036854775807',
          '',
        ].join('\n');
        fsWriteFileSync(tomlPath, original);

        const target: EditorMcpTarget = {
          id: 'codex' as McpWiringEditorId,
          label: 'Codex',
          format: 'toml',
          topLevelKey: 'mcp_servers',
          serverName: () => 'open-knowledge',
          configPath: () => tomlPath,
          buildEntry: () => buildManagedServerEntry({ mode: 'published' }),
          scope: 'global',
        };

        expect(classifyExistingMcpEntry(target, '', undefined, tomlPath)).toEqual({
          kind: 'no-entry',
        });

        const realFs: McpWiringFsOps = {
          existsSync: (p) => fsExistsSync(p),
          readFileSync: (p) => fsReadFileSync(p, 'utf8'),
          writeFileSync: (p, c) => fsWriteFileSync(p, c),
          mkdirSync: (p, o) => {
            fsMkdirSync(p, o);
          },
          renameSync: (from, to) => fsRenameSync(from, to),
          unlinkSync: (p) => fsUnlinkSync(p),
        };
        const writes: McpWiringEditorId[][] = [];
        const cli: McpWiringCliSurface = {
          detectInstalledEditors: () => ['codex' as McpWiringEditorId],
          classifyExistingMcpEntry: () => classifyExistingMcpEntry(target, '', undefined, tomlPath),
          readExistingMcpEntry: () => null,
          allEditorIds: ['codex' as McpWiringEditorId],
          editorTargets: { codex: target } as Record<McpWiringEditorId, EditorMcpTarget>,
          writeUserMcpConfigs: async ({ editors }) => {
            writes.push([...editors]);
            fsWriteFileSync(tomlPath, '{"mcp_servers":{"open-knowledge":{}}}');
            return editors.map((editorId) => ({
              editorId,
              label: editorId,
              action: 'written' as const,
              configPath: tomlPath,
              serverName: 'open-knowledge',
            }));
          },
        };

        const events: Array<Record<string, unknown>> = [];
        const result = await checkAndRepairMcpWiringOnStartup({
          isPackaged: true,
          executablePath: PACKAGED_EXE,
          home: dir,
          platform: 'darwin',
          ipcMain: inertIpcMain,
          cli,
          fs: realFs,
          logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
        });

        expect(result.status).toBe('ok');
        expect(fsReadFileSync(tomlPath, 'utf8')).toBe(original);
        expect(readdirSync(dir).some((name) => name.includes('.broken-'))).toBe(false);
        expect(writes).toEqual([]);
        expect(events.find((e) => e.event === 'mcp-config-decline')).toBeUndefined();
      },
    );

    test('real classify on a genuinely-malformed TOML → decline, byte-unchanged, no write, bounded signal', async () => {
      dir = mkdtempSync(join(tmpdir(), 'ok-decline-sweep-'));
      const tomlPath = join(dir, 'config.toml');
      const original = ['# keep my comments', 'model = "gpt-5"', 'broken = "unterminated', ''].join(
        '\n',
      );
      fsWriteFileSync(tomlPath, original);

      const target: EditorMcpTarget = {
        id: 'codex' as McpWiringEditorId,
        label: 'Codex',
        format: 'toml',
        topLevelKey: 'mcp_servers',
        serverName: () => 'open-knowledge',
        configPath: () => tomlPath,
        buildEntry: () => buildManagedServerEntry({ mode: 'published' }),
        scope: 'global',
      };

      expect(classifyExistingMcpEntry(target, '', undefined, tomlPath)).toEqual({
        kind: 'decline',
        reason: 'unparseable',
      });

      const realFs: McpWiringFsOps = {
        existsSync: (p) => fsExistsSync(p),
        readFileSync: (p) => fsReadFileSync(p, 'utf8'),
        writeFileSync: (p, c) => fsWriteFileSync(p, c),
        mkdirSync: (p, o) => {
          fsMkdirSync(p, o);
        },
        renameSync: (from, to) => fsRenameSync(from, to),
        unlinkSync: (p) => fsUnlinkSync(p),
      };
      const writes: McpWiringEditorId[][] = [];
      const cli: McpWiringCliSurface = {
        detectInstalledEditors: () => ['codex' as McpWiringEditorId],
        classifyExistingMcpEntry: () => classifyExistingMcpEntry(target, '', undefined, tomlPath),
        readExistingMcpEntry: () => null,
        allEditorIds: ['codex' as McpWiringEditorId],
        editorTargets: { codex: target } as Record<McpWiringEditorId, EditorMcpTarget>,
        writeUserMcpConfigs: async ({ editors }) => {
          writes.push([...editors]);
          fsWriteFileSync(tomlPath, '{"mcp_servers":{"open-knowledge":{}}}');
          return editors.map((editorId) => ({
            editorId,
            label: editorId,
            action: 'written' as const,
            configPath: tomlPath,
            serverName: 'open-knowledge',
          }));
        },
      };

      const events: Array<Record<string, unknown>> = [];
      const result = await checkAndRepairMcpWiringOnStartup({
        isPackaged: true,
        executablePath: PACKAGED_EXE,
        home: dir,
        platform: 'darwin',
        ipcMain: inertIpcMain,
        cli,
        fs: realFs,
        logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
      });

      expect(result.status).toBe('ok');
      expect(fsReadFileSync(tomlPath, 'utf8')).toBe(original);
      expect(readdirSync(dir).some((name) => name.includes('.broken-'))).toBe(false);
      expect(writes).toEqual([]);
      const decline = events.find((e) => e.event === 'mcp-config-decline');
      expect(decline).toMatchObject({
        event: 'mcp-config-decline',
        scope: 'user',
        surface: 'desktop-startup',
        editorId: 'codex',
        reason: 'unparseable',
      });
      expect(decline).not.toHaveProperty('configPath');
    });

    test('fallback engine: the same valid i64 config is declined, never reset (off-macOS / no-prebuilt-binary host)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'ok-fallback-i64-'));
      const tomlPath = join(dir, 'config.toml');
      const original = [
        '# my codex config — keep my comments!',
        'model = "gpt-5"',
        '',
        '[mcp_servers.other]',
        'command = "node"',
        'startup_timeout_ms = 9223372036854775807',
        '',
      ].join('\n');
      fsWriteFileSync(tomlPath, original);

      const target: EditorMcpTarget = {
        id: 'codex' as McpWiringEditorId,
        label: 'Codex',
        format: 'toml',
        topLevelKey: 'mcp_servers',
        serverName: () => 'open-knowledge',
        configPath: () => tomlPath,
        buildEntry: () => buildManagedServerEntry({ mode: 'published' }),
        scope: 'global',
      };

      const realFs: McpWiringFsOps = {
        existsSync: (p) => fsExistsSync(p),
        readFileSync: (p) => fsReadFileSync(p, 'utf8'),
        writeFileSync: (p, c) => fsWriteFileSync(p, c),
        mkdirSync: (p, o) => {
          fsMkdirSync(p, o);
        },
        renameSync: (from, to) => fsRenameSync(from, to),
        unlinkSync: (p) => fsUnlinkSync(p),
      };
      const writes: McpWiringEditorId[][] = [];
      const cli: McpWiringCliSurface = {
        detectInstalledEditors: () => ['codex' as McpWiringEditorId],
        classifyExistingMcpEntry: () =>
          classifyWithOverridableEngine(target, '', undefined, tomlPath),
        readExistingMcpEntry: () => null,
        allEditorIds: ['codex' as McpWiringEditorId],
        editorTargets: { codex: target } as Record<McpWiringEditorId, EditorMcpTarget>,
        writeUserMcpConfigs: async ({ editors }) => {
          writes.push([...editors]);
          fsWriteFileSync(tomlPath, '{"mcp_servers":{"open-knowledge":{}}}');
          return editors.map((editorId) => ({
            editorId,
            label: editorId,
            action: 'written' as const,
            configPath: tomlPath,
            serverName: 'open-knowledge',
          }));
        },
      };

      const events: Array<Record<string, unknown>> = [];
      try {
        setTomlConfigEngineForTesting(createTomlConfigEngine(() => null));

        expect(classifyWithOverridableEngine(target, '', undefined, tomlPath)).toEqual({
          kind: 'decline',
          reason: 'unparseable',
        });

        const result = await checkAndRepairMcpWiringOnStartup({
          isPackaged: true,
          executablePath: PACKAGED_EXE,
          home: dir,
          platform: 'darwin',
          ipcMain: inertIpcMain,
          cli,
          fs: realFs,
          logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
        });

        expect(result.status).toBe('ok');
      } finally {
        setTomlConfigEngineForTesting(null);
      }

      expect(fsReadFileSync(tomlPath, 'utf8')).toBe(original);
      expect(readdirSync(dir).some((name) => name.includes('.broken-'))).toBe(false);
      expect(writes).toEqual([]);
      const decline = events.find((e) => e.event === 'mcp-config-decline');
      expect(decline).toMatchObject({
        event: 'mcp-config-decline',
        scope: 'user',
        surface: 'desktop-startup',
        editorId: 'codex',
        reason: 'unparseable',
      });
      expect(decline).not.toHaveProperty('configPath');
    });
  });
});

describe('MCP status marker', () => {
  test('writes confirmed marker without cliPath', () => {
    const fs = memoryFs();
    const marker: McpStatusMarker = {
      configured: true,
      configuredAt: '2026-05-26T00:00:00.000Z',
      editors: ['claude'],
    };
    writeMcpStatusMarker('/home/alice', marker, fs);
    expect(JSON.parse(fs.files['/home/alice/.ok/mcp-status.json'])).toEqual(marker);
  });

  test('reader accepts legacy confirmed marker carrying cliPath', () => {
    const fs = memoryFs({
      '/home/alice/.ok/mcp-status.json': JSON.stringify({
        configured: true,
        configuredAt: '2026-05-26T00:00:00.000Z',
        editors: [],
        cliPath: '/old/path',
      }),
    });
    expect(readMcpStatusMarker('/home/alice', fs)).toEqual({
      configured: true,
      configuredAt: '2026-05-26T00:00:00.000Z',
      editors: [],
      cliPath: '/old/path',
    });
  });
});

type WiringOpts = Parameters<typeof runMcpWiringOnFirstLaunch>[0];

function stubIpcMain(): WiringOpts['ipcMain'] & {
  handlers: Map<string, (...args: unknown[]) => unknown>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, fn: (...args: unknown[]) => unknown) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as WiringOpts['ipcMain'] & {
    handlers: Map<string, (...args: unknown[]) => unknown>;
  };
}

function fakeWebContents(
  id: number,
  opts: { failSend?: boolean } = {},
): McpWiringDispatchTarget & { sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    id,
    sent,
    send(channel: string, payload?: unknown) {
      if (opts.failSend) throw new Error('WebContents was destroyed');
      sent.push({ channel, payload });
    },
  };
}

function buildFirstLaunchCli(): { cli: McpWiringCliSurface; writes: McpWiringEditorId[][] } {
  const target = fakeTarget('claude' as McpWiringEditorId);
  const writes: McpWiringEditorId[][] = [];
  const cli: McpWiringCliSurface = {
    detectInstalledEditors: () => ['claude' as McpWiringEditorId],
    classifyExistingMcpEntry: () => ({ kind: 'absent' }) as McpEntryClassification,
    readExistingMcpEntry: () => null,
    allEditorIds: ['claude' as McpWiringEditorId],
    editorTargets: { claude: target } as Record<McpWiringEditorId, EditorMcpTarget>,
    writeUserMcpConfigs: async ({ editors }) => {
      writes.push([...editors]);
      return editors.map((editorId) => ({
        editorId,
        label: editorId,
        action: 'written' as const,
        configPath: target.configPath('', '/home/u'),
        serverName: 'open-knowledge',
      }));
    },
  };
  return { cli, writes };
}

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, event() {} };

const STUB_PATH_DESCRIPTOR = {
  shellDetected: true,
  rcFilesToTouch: ['~/.zshrc'],
  alreadyInstalled: false,
} as const;

function stubPathInstall(
  overrides: Partial<McpWiringPathInstallSurface> = {},
): McpWiringPathInstallSurface & { consentCalls: Array<'granted' | 'declined'> } {
  const consentCalls: Array<'granted' | 'declined'> = [];
  return {
    consentCalls,
    computeDescriptor: () => ({ ...STUB_PATH_DESCRIPTOR, rcFilesToTouch: ['~/.zshrc'] }),
    applyConsent: async (status) => {
      consentCalls.push(status);
      return { ok: true as const };
    },
    ...overrides,
  };
}

function stubSkills(
  descriptors: ReturnType<McpWiringSkillsSurface['computeDescriptors']> = [],
  overrides: Partial<McpWiringSkillsSurface> = {},
): McpWiringSkillsSurface & { consentCalls: string[][] } {
  const consentCalls: string[][] = [];
  return {
    consentCalls,
    computeDescriptors: () => descriptors,
    applyConsent: async (enabledIds) => {
      consentCalls.push([...enabledIds]);
      return { ok: true as const };
    },
    ...overrides,
  };
}

function buildWiringOpts(overrides: Partial<WiringOpts> = {}): WiringOpts {
  const { cli } = buildFirstLaunchCli();
  return {
    isPackaged: true,
    executablePath: PACKAGED_EXE,
    home: '/home/u',
    platform: 'darwin',
    ipcMain: stubIpcMain(),
    cli,
    pathInstall: stubPathInstall(),
    skills: stubSkills(),
    fs: memoryFs(),
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

describe('runMcpWiringOnFirstLaunch — skills consent leg', () => {
  const TWO_SKILLS = [
    {
      id: 'discovery',
      name: 'open-knowledge-discovery',
      paths: ['~/.claude/skills/open-knowledge-discovery'],
    },
    {
      id: 'write-skill',
      name: 'open-knowledge-write-skill',
      paths: ['~/.claude/skills/open-knowledge-write-skill'],
    },
  ];

  test('confirm applies the checked skill subset and emits per-bundle telemetry', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const { cli } = buildFirstLaunchCli();
    const skills = stubSkills(TWO_SKILLS);
    const events: Array<Record<string, unknown>> = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      event: (p: { event: string; [k: string]: unknown }) => events.push(p),
    };
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, skills, logger, immediateDispatchTarget: wc }),
    );

    expect(wc.sent[0]?.payload).toMatchObject({ globalSkills: TWO_SKILLS });

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.(
      { sender: { id: 11 } },
      { editorIds: ['claude'], skills: ['discovery'] },
    );
    expect(result).toEqual({ ok: true });
    expect(skills.consentCalls).toEqual([['discovery']]);
    expect(events).toContainEqual({
      event: 'mcp-wiring-skill-consent-granted',
      bundle: 'discovery',
    });
    expect(events).toContainEqual({
      event: 'mcp-wiring-skill-consent-declined',
      bundle: 'write-skill',
    });
  });

  test('an omitted skills field records no decision and leaves installs standing', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const { cli } = buildFirstLaunchCli();
    const skills = stubSkills(TWO_SKILLS);
    const events: Array<Record<string, unknown>> = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      event: (p: { event: string; [k: string]: unknown }) => events.push(p),
    };
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, skills, logger, immediateDispatchTarget: wc }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.({ sender: { id: 11 } }, { editorIds: [] });
    expect(result).toEqual({ ok: true });
    expect(skills.consentCalls).toEqual([]);
    expect(events.filter((e) => String(e.event).startsWith('mcp-wiring-skill-consent'))).toEqual(
      [],
    );
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({ configured: true });
  });

  test('an explicit empty skills array still declines every offered bundle', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const { cli } = buildFirstLaunchCli();
    const skills = stubSkills(TWO_SKILLS);
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, skills, immediateDispatchTarget: wc }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    await confirm?.({ sender: { id: 11 } }, { editorIds: [], skills: [] });
    expect(skills.consentCalls).toEqual([[]]);
  });

  test('a failed skills leg defers the marker so the dialog re-fires', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const { cli } = buildFirstLaunchCli();
    const skills = stubSkills(TWO_SKILLS, {
      applyConsent: async () => ({ ok: false as const, error: 'disk full' }),
    });
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, skills, immediateDispatchTarget: wc }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.(
      { sender: { id: 11 } },
      { editorIds: ['claude'], skills: ['discovery'] },
    );
    expect(result?.ok).toBe(false);
    expect(readMcpStatusMarker('/home/u', fs)).toBeNull();
  });
});

describe('runMcpWiringOnFirstLaunch — mid-session immediate dispatch', () => {
  test('show dispatches to the provided target and binds confirm to its sender', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const { cli, writes } = buildFirstLaunchCli();
    const handle = runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, immediateDispatchTarget: wc }),
    );

    expect(handle.armed).toBe(true);
    expect(wc.sent).toEqual([
      {
        channel: 'ok:mcp-wiring:show',
        payload: {
          origin: 'first-run',
          detectedEditors: [
            {
              id: 'claude',
              label: 'claude',
              detected: true,
              willReplace: false,
              configPath: '~/.config-for-claude.json',
              entryLocator: 'mcpServers.open-knowledge',
            },
          ],
          pathInstall: {
            shellDetected: true,
            rcFilesToTouch: ['~/.zshrc'],
            alreadyInstalled: false,
          },
          globalSkills: [],
        },
      },
    ]);
    expect(ipcMain.handlers.has('ok:mcp-wiring:renderer-ready')).toBe(false);

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    expect(confirm).toBeDefined();
    const result = await confirm?.({ sender: { id: 11 } }, { editorIds: ['claude'] });
    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([['claude' as McpWiringEditorId]]);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({
      configured: true,
      editors: ['claude'],
    });
  });

  test('a declined editor is not recorded as configured and emits the decline signal', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const events: Array<Record<string, unknown>> = [];
    const claude = fakeTarget('claude' as McpWiringEditorId);
    const cursor = fakeTarget('cursor' as McpWiringEditorId);
    const cli: McpWiringCliSurface = {
      detectInstalledEditors: () => ['claude' as McpWiringEditorId, 'cursor' as McpWiringEditorId],
      classifyExistingMcpEntry: () => ({ kind: 'absent' }) as McpEntryClassification,
      readExistingMcpEntry: () => null,
      allEditorIds: ['claude' as McpWiringEditorId, 'cursor' as McpWiringEditorId],
      editorTargets: { claude, cursor } as Record<McpWiringEditorId, EditorMcpTarget>,
      writeUserMcpConfigs: async ({ editors }) =>
        editors.map((editorId) =>
          editorId === 'cursor'
            ? {
                editorId,
                label: editorId,
                action: 'declined' as const,
                configPath: '/home/u/.cursor/mcp.json',
                serverName: 'open-knowledge',
                declineReason: 'unparseable' as const,
              }
            : {
                editorId,
                label: editorId,
                action: 'written' as const,
                configPath: '/home/u/.claude.json',
                serverName: 'open-knowledge',
              },
        ),
    };
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain,
        cli,
        fs,
        immediateDispatchTarget: wc,
        logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
      }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.({ sender: { id: 11 } }, { editorIds: ['claude', 'cursor'] });
    expect(result).toEqual({ ok: true });

    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({
      configured: true,
      editors: ['claude'],
    });

    const decline = events.find((e) => e.event === 'mcp-config-decline');
    expect(decline).toMatchObject({
      event: 'mcp-config-decline',
      scope: 'user',
      surface: 'desktop-firstlaunch',
      editorId: 'cursor',
      reason: 'unparseable',
    });
    expect(decline).not.toHaveProperty('configPath');
  });

  test('confirm from a window other than the dispatch target is rejected', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const { cli, writes } = buildFirstLaunchCli();
    runMcpWiringOnFirstLaunch(buildWiringOpts({ ipcMain, cli, immediateDispatchTarget: wc }));

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = (await confirm?.({ sender: { id: 99 } }, { editorIds: ['claude'] })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  test('skip from the dispatch target writes the skip marker without touching configs', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const { cli, writes } = buildFirstLaunchCli();
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain,
        cli,
        fs,
        immediateDispatchTarget: wc,
        now: () => new Date('2026-06-10T00:00:00.000Z'),
      }),
    );

    const skip = ipcMain.handlers.get('ok:mcp-wiring:skip');
    expect(skip).toBeDefined();
    const result = await skip?.({ sender: { id: 11 } });
    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([]);
    expect(readMcpStatusMarker('/home/u', fs)).toEqual({
      configured: false,
      skippedAt: '2026-06-10T00:00:00.000Z',
    });
  });

  test('skip from a window other than the dispatch target is rejected', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    runMcpWiringOnFirstLaunch(buildWiringOpts({ ipcMain, fs, immediateDispatchTarget: wc }));

    const skip = ipcMain.handlers.get('ok:mcp-wiring:skip');
    const result = (await skip?.({ sender: { id: 99 } })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(readMcpStatusMarker('/home/u', fs)).toBeNull();
  });

  test('forceShow + immediate target re-fires the dialog over a prior skip marker', () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(7);
    const fs = memoryFs({
      '/home/u/.ok/mcp-status.json': JSON.stringify({
        configured: false,
        skippedAt: '2026-05-26T00:00:00.000Z',
      }),
    });
    const handle = runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, fs, forceShow: true, immediateDispatchTarget: wc }),
    );
    expect(handle.armed).toBe(true);
    expect(wc.sent.map((s) => s.channel)).toEqual(['ok:mcp-wiring:show']);
    expect(ipcMain.handlers.has('ok:mcp-wiring:renderer-ready')).toBe(false);
  });

  test('failed immediate dispatch leaves the mount-ack fallback armed', async () => {
    const ipcMain = stubIpcMain();
    const broken = fakeWebContents(11, { failSend: true });
    const fs = memoryFs();
    const { cli, writes } = buildFirstLaunchCli();
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, immediateDispatchTarget: broken }),
    );

    const ready = ipcMain.handlers.get('ok:mcp-wiring:renderer-ready');
    expect(ready).toBeDefined();

    const wc2 = fakeWebContents(22);
    ready?.({ sender: wc2 });
    expect(wc2.sent.map((s) => s.channel)).toEqual(['ok:mcp-wiring:show']);
    expect(ipcMain.handlers.has('ok:mcp-wiring:renderer-ready')).toBe(false);

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.({ sender: { id: 22 } }, { editorIds: ['claude'] });
    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([['claude' as McpWiringEditorId]]);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({
      configured: true,
      editors: ['claude'],
    });
  });

  test('forceShow marks the payload as user-initiated, the boot path as first-run', () => {
    const forced = fakeWebContents(31);
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain: stubIpcMain(),
        fs: memoryFs(),
        forceShow: true,
        immediateDispatchTarget: forced,
      }),
    );
    expect(forced.sent[0]?.payload).toMatchObject({ origin: 'reconfigure' });

    const booted = fakeWebContents(32);
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain: stubIpcMain(),
        fs: memoryFs(),
        immediateDispatchTarget: booted,
      }),
    );
    expect(booted.sent[0]?.payload).toMatchObject({ origin: 'first-run' });
  });

  test('no immediate target preserves the boot-path mount-ack behavior', () => {
    const ipcMain = stubIpcMain();
    runMcpWiringOnFirstLaunch(buildWiringOpts({ ipcMain }));

    expect(ipcMain.handlers.has('ok:mcp-wiring:renderer-ready')).toBe(true);
    const wc = fakeWebContents(5);
    ipcMain.handlers.get('ok:mcp-wiring:renderer-ready')?.({ sender: wc });
    expect(wc.sent.map((s) => s.channel)).toEqual(['ok:mcp-wiring:show']);
  });
});

describe('runMcpWiringOnFirstLaunch — PATH consent leg', () => {
  test('confirm with pathInstall:true applies granted consent and writes the marker', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const pathInstall = stubPathInstall();
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, fs, pathInstall, immediateDispatchTarget: wc }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.(
      { sender: { id: 11 } },
      { editorIds: ['claude'], pathInstall: true },
    );
    expect(result).toEqual({ ok: true });
    expect(pathInstall.consentCalls).toEqual(['granted']);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({ configured: true });
  });

  test('confirm with pathInstall:false records the decline (and still wires editors)', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const pathInstall = stubPathInstall();
    const { cli, writes } = buildFirstLaunchCli();
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, cli, fs, pathInstall, immediateDispatchTarget: wc }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.(
      { sender: { id: 11 } },
      { editorIds: ['claude'], pathInstall: false },
    );
    expect(result).toEqual({ ok: true });
    expect(pathInstall.consentCalls).toEqual(['declined']);
    expect(writes).toEqual([['claude' as McpWiringEditorId]]);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({ configured: true });
  });

  test('confirm without pathInstall leaves the PATH surface untouched (no decision solicited)', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const pathInstall = stubPathInstall();
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, fs, pathInstall, immediateDispatchTarget: wc }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const result = await confirm?.({ sender: { id: 11 } }, { editorIds: ['claude'] });
    expect(result).toEqual({ ok: true });
    expect(pathInstall.consentCalls).toEqual([]);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({ configured: true });
  });

  test('a failed PATH leg defers the marker and allows a same-boot retry (deferred-marker mirror)', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const events: Array<Record<string, unknown>> = [];
    const outcomes = [
      { ok: false as const, error: 'EACCES: /home/u/.zshrc' },
      { ok: true as const },
    ];
    const consentCalls: Array<'granted' | 'declined'> = [];
    const pathInstall: McpWiringPathInstallSurface = {
      computeDescriptor: () => ({ ...STUB_PATH_DESCRIPTOR, rcFilesToTouch: ['~/.zshrc'] }),
      applyConsent: async (status) => {
        consentCalls.push(status);
        return outcomes.shift() ?? { ok: true as const };
      },
    };
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain,
        fs,
        pathInstall,
        immediateDispatchTarget: wc,
        logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
      }),
    );

    const confirm = ipcMain.handlers.get('ok:mcp-wiring:confirm');
    const first = (await confirm?.(
      { sender: { id: 11 } },
      { editorIds: ['claude'], pathInstall: true },
    )) as { ok: boolean; error?: string };
    expect(first.ok).toBe(false);
    expect(first.error).toContain('PATH');
    expect(readMcpStatusMarker('/home/u', fs)).toBeNull();
    expect(events.find((e) => e.event === 'mcp-wiring-path-consent-failed')).toMatchObject({
      decision: 'granted',
    });

    const second = await confirm?.(
      { sender: { id: 11 } },
      { editorIds: ['claude'], pathInstall: true },
    );
    expect(second).toEqual({ ok: true });
    expect(consentCalls).toEqual(['granted', 'granted']);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({ configured: true });
  });

  test('a throwing descriptor degrades to a hidden PATH row instead of killing the dialog', () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const events: Array<Record<string, unknown>> = [];
    const pathInstall = stubPathInstall({
      computeDescriptor: () => {
        throw new Error('marker unreadable');
      },
    });
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain,
        pathInstall,
        immediateDispatchTarget: wc,
        logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
      }),
    );

    expect(wc.sent).toHaveLength(1);
    expect((wc.sent[0]?.payload as { pathInstall: unknown }).pathInstall).toEqual({
      shellDetected: false,
      rcFilesToTouch: [],
      alreadyInstalled: false,
    });
    expect(events.some((e) => e.event === 'mcp-wiring-path-descriptor-failed')).toBe(true);
  });

  test('a throwing skills descriptor degrades to no skill rows instead of killing the dialog', () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const events: Array<Record<string, unknown>> = [];
    const skills = stubSkills([], {
      computeDescriptors: () => {
        throw new Error('bundle dir unreadable');
      },
    });
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({
        ipcMain,
        skills,
        immediateDispatchTarget: wc,
        logger: { info() {}, warn() {}, error() {}, event: (e) => events.push(e) },
      }),
    );

    expect(wc.sent).toHaveLength(1);
    expect((wc.sent[0]?.payload as { globalSkills: unknown }).globalSkills).toEqual([]);
    expect(events.some((e) => e.event === 'mcp-wiring-skill-descriptors-failed')).toBe(true);
    expect(ipcMain.handlers.has('ok:mcp-wiring:confirm')).toBe(true);
  });

  test('skip never touches the PATH surface', async () => {
    const ipcMain = stubIpcMain();
    const wc = fakeWebContents(11);
    const fs = memoryFs();
    const pathInstall = stubPathInstall();
    runMcpWiringOnFirstLaunch(
      buildWiringOpts({ ipcMain, fs, pathInstall, immediateDispatchTarget: wc }),
    );

    const skip = ipcMain.handlers.get('ok:mcp-wiring:skip');
    const result = await skip?.({ sender: { id: 11 } });
    expect(result).toEqual({ ok: true });
    expect(pathInstall.consentCalls).toEqual([]);
    expect(readMcpStatusMarker('/home/u', fs)).toMatchObject({ configured: false });
  });
});
