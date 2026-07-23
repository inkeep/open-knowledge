import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, test } from 'vitest';
import type {
  IntegrationsSetRequest,
  IntegrationsSetResult,
  IntegrationsStatus,
  McpWiringEditorId,
} from '../shared/ipc-channels.ts';
import {
  classifyEditorState,
  type IntegrationsCliSurface,
  type IntegrationsPathSurface,
  type IntegrationsSkillsSurface,
  type RegisterIntegrationsSettingsOpts,
  registerIntegrationsSettings,
} from './integrations-settings.ts';
import type { McpStatusMarker, McpWiringFsOps } from './mcp-wiring.ts';

const HOME = '/test-home';
const MARKER_PATH = `${HOME}/.ok/mcp-status.json`;

/** In-memory FsOps for the mcp-status marker. */
function memFs(initial: Record<string, string> = {}): McpWiringFsOps & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFileSync: (path, content) => {
      files.set(path, content);
    },
    mkdirSync: () => {},
    renameSync: (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.set(newPath, content);
      files.delete(oldPath);
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
  };
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  };
}

const EVENT = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

const OWN_ENTRY = { own: true };
const FOREIGN_ENTRY = { own: false };

interface CliOverrides {
  classifications?: Partial<
    Record<McpWiringEditorId, ReturnType<IntegrationsCliSurface['classifyExistingMcpEntry']>>
  >;
  writeAction?: 'written' | 'overwritten' | 'failed' | 'declined';
  writeError?: string;
  removeKind?: 'removed' | 'not-present' | 'left-foreign' | 'declined';
  detected?: McpWiringEditorId[];
}

function makeCli(overrides: CliOverrides = {}): IntegrationsCliSurface & {
  writes: McpWiringEditorId[][];
  removals: McpWiringEditorId[];
} {
  const writes: McpWiringEditorId[][] = [];
  const removals: McpWiringEditorId[] = [];
  return {
    writes,
    removals,
    allEditorIds: ['claude', 'cursor'] as McpWiringEditorId[],
    editorLabel: (id) => (id === 'claude' ? 'Claude' : 'Cursor'),
    detectInstalledEditors: () => overrides.detected ?? (['claude'] as McpWiringEditorId[]),
    classifyExistingMcpEntry: (id) =>
      overrides.classifications?.[id] ?? { kind: 'no-entry' as const },
    isOwnEntry: (entry) => entry === OWN_ENTRY,
    editorConfigPath: (id) => `~/.${id}.json`,
    editorEntryLocator: () => 'mcpServers.open-knowledge',
    writeUserMcpConfigs: async (opts) => {
      writes.push([...opts.editors]);
      return opts.editors.map((editorId) => ({
        editorId,
        action: overrides.writeAction ?? ('written' as const),
        error: overrides.writeError,
      }));
    },
    removeUserMcpEntry: (id) => {
      removals.push(id);
      return { kind: overrides.removeKind ?? 'removed' };
    },
  };
}

function makePath(installed = false): IntegrationsPathSurface & { calls: string[] } {
  const calls: string[] = [];
  let isInstalled = installed;
  return {
    calls,
    computeStatus: () => ({
      shellDetected: true,
      rcFilesToTouch: ['~/.zshrc'],
      installed: isInstalled,
    }),
    install: async () => {
      calls.push('install');
      isInstalled = true;
      return { ok: true };
    },
    uninstall: async () => {
      calls.push('uninstall');
      isInstalled = false;
      return { ok: true };
    },
  };
}

function makeSkills(
  installedIds: string[] = [],
): IntegrationsSkillsSurface & { calls: Array<[string, boolean]> } {
  const calls: Array<[string, boolean]> = [];
  const installed = new Set(installedIds);
  return {
    calls,
    computeStatuses: () => [
      {
        id: 'discovery',
        name: 'open-knowledge-discovery',
        installed: installed.has('discovery'),
        paths: ['~/.agents/skills/open-knowledge-discovery'],
      },
      {
        id: 'write-skill',
        name: 'open-knowledge-write-skill',
        installed: installed.has('write-skill'),
        paths: ['~/.agents/skills/open-knowledge-write-skill'],
      },
    ],
    setEnabled: async (bundleId, enabled) => {
      calls.push([bundleId, enabled]);
      if (enabled) installed.add(bundleId);
      else installed.delete(bundleId);
      return { ok: true };
    },
  };
}

function setup(overrides: Partial<RegisterIntegrationsSettingsOpts> = {}) {
  const ipcMain = fakeIpcMain();
  const cli = makeCli();
  const path = makePath();
  const skills = makeSkills();
  const fs = memFs();
  const handle = registerIntegrationsSettings({
    home: HOME,
    available: true,
    ipcMain,
    cli,
    path,
    skills,
    fs,
    now: () => new Date('2026-07-07T00:00:00.000Z'),
    logger: { warn: () => {}, error: () => {}, event: () => {} },
    ...overrides,
  });
  const dispatch = ipcMain.handlers.get('ok:integrations:dispatch');
  if (!dispatch) throw new Error('dispatch handler not registered');
  const status = () => dispatch(EVENT, { kind: 'status' }) as Promise<IntegrationsStatus>;
  const set = (request: IntegrationsSetRequest) =>
    dispatch(EVENT, { kind: 'set', ...request }) as Promise<IntegrationsSetResult>;
  return { ipcMain, cli, path, skills, fs, handle, status, set };
}

describe('classifyEditorState', () => {
  const isOwn = (entry: unknown) => entry === OWN_ENTRY;

  test('maps every classification kind to its row state', () => {
    expect(classifyEditorState({ kind: 'absent' }, isOwn)).toBe('not-installed');
    expect(classifyEditorState({ kind: 'no-entry' }, isOwn)).toBe('not-installed');
    expect(classifyEditorState({ kind: 'decline' }, isOwn)).toBe('unmanageable');
    expect(classifyEditorState({ kind: 'present', entry: OWN_ENTRY }, isOwn)).toBe('installed');
    expect(classifyEditorState({ kind: 'present', entry: FOREIGN_ENTRY }, isOwn)).toBe('foreign');
  });
});

describe('ok:integrations:dispatch — status', () => {
  test('returns per-editor state, detection, PATH and skill rows', async () => {
    const { status } = setup({
      cli: makeCli({
        classifications: { claude: { kind: 'present', entry: OWN_ENTRY } },
        detected: ['claude'] as McpWiringEditorId[],
      }),
      skills: makeSkills(['discovery']),
    });
    const snapshot = await status();
    expect(snapshot.available).toBe(true);
    expect(snapshot.editors).toEqual([
      {
        id: 'claude',
        label: 'Claude',
        detected: true,
        state: 'installed',
        configPath: '~/.claude.json',
        entryLocator: 'mcpServers.open-knowledge',
      },
      {
        id: 'cursor',
        label: 'Cursor',
        detected: false,
        state: 'not-installed',
        configPath: '~/.cursor.json',
        entryLocator: 'mcpServers.open-knowledge',
      },
    ]);
    expect(snapshot.path).toEqual({
      shellDetected: true,
      rcFilesToTouch: ['~/.zshrc'],
      installed: false,
    });
    expect(snapshot.skills).toEqual([
      {
        id: 'discovery',
        name: 'open-knowledge-discovery',
        installed: true,
        paths: ['~/.agents/skills/open-knowledge-discovery'],
      },
      {
        id: 'write-skill',
        name: 'open-knowledge-write-skill',
        installed: false,
        paths: ['~/.agents/skills/open-knowledge-write-skill'],
      },
    ]);
  });

  test('a throwing per-editor classify degrades that row to unmanageable, not the whole section', async () => {
    const cli = makeCli();
    cli.classifyExistingMcpEntry = (id) => {
      if (id === 'claude') throw new Error('EACCES');
      return { kind: 'no-entry' };
    };
    const { status } = setup({ cli });
    const snapshot = await status();
    expect(snapshot.editors[0]?.state).toBe('unmanageable');
    expect(snapshot.editors[1]?.state).toBe('not-installed');
  });

  test('throwing path/skill surfaces degrade to hidden rows', async () => {
    const path = makePath();
    path.computeStatus = () => {
      throw new Error('boom');
    };
    const skills = makeSkills();
    skills.computeStatuses = () => {
      throw new Error('boom');
    };
    const { status } = setup({ path, skills });
    const snapshot = await status();
    expect(snapshot.path).toEqual({ shellDetected: false, rcFilesToTouch: [], installed: false });
    expect(snapshot.skills).toEqual([]);
  });
});

describe('ok:integrations:dispatch — set editor', () => {
  test('enable writes the one editor and returns ok with a fresh snapshot', async () => {
    const cli = makeCli();
    const { set } = setup({ cli });
    const result = await set({ component: { kind: 'editor', id: 'claude' }, enabled: true });
    expect(result.ok).toBe(true);
    expect(cli.writes).toEqual([['claude']]);
  });

  test('disable removes the entry; a foreign entry is refused with the config untouched', async () => {
    const cli = makeCli({ removeKind: 'left-foreign' });
    const { set } = setup({ cli });
    const result = await set({ component: { kind: 'editor', id: 'claude' }, enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("isn't one OpenKnowledge wrote");
    expect(cli.removals).toEqual(['claude']);
  });

  test('a declined write surfaces the left-unchanged error', async () => {
    const { set } = setup({ cli: makeCli({ writeAction: 'declined' }) });
    const result = await set({ component: { kind: 'editor', id: 'cursor' }, enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Couldn't safely edit Cursor's config");
  });

  test('a failed write surfaces its error', async () => {
    const { set } = setup({ cli: makeCli({ writeAction: 'failed', writeError: 'EROFS' }) });
    const result = await set({ component: { kind: 'editor', id: 'claude' }, enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('EROFS');
  });

  test('unknown editor id is refused', async () => {
    const { set } = setup();
    const result = await set({
      component: { kind: 'editor', id: 'not-an-editor' as McpWiringEditorId },
      enabled: true,
    });
    expect(result.ok).toBe(false);
  });

  test('an existing marker is refreshed to the installed set; an absent marker is never created', async () => {
    const priorMarker: McpStatusMarker = {
      configured: true,
      configuredAt: '2026-01-01T00:00:00.000Z',
      editors: ['claude'],
    };
    const markerFs = memFs({ [MARKER_PATH]: JSON.stringify(priorMarker) });
    const withMarker = setup({
      fs: markerFs,
      cli: makeCli({
        classifications: {
          claude: { kind: 'present', entry: OWN_ENTRY },
          cursor: { kind: 'present', entry: OWN_ENTRY },
        },
      }),
    });
    await withMarker.set({ component: { kind: 'editor', id: 'cursor' }, enabled: true });
    const marker = JSON.parse(markerFs.files.get(MARKER_PATH) ?? 'null');
    expect(marker.configured).toBe(true);
    expect(marker.editors).toEqual(['claude', 'cursor']);
    // Original decision timestamp is preserved.
    expect(marker.configuredAt).toBe('2026-01-01T00:00:00.000Z');

    const withoutMarker = setup();
    await withoutMarker.set({ component: { kind: 'editor', id: 'claude' }, enabled: true });
    expect(withoutMarker.fs.files.has(MARKER_PATH)).toBe(false);
  });
});

describe('ok:integrations:dispatch — set path / skill', () => {
  test('path toggles route to install/uninstall and the snapshot reflects the new state', async () => {
    const path = makePath(false);
    const { set } = setup({ path });
    const enabled = await set({ component: { kind: 'path' }, enabled: true });
    expect(enabled.ok).toBe(true);
    expect(enabled.status.path.installed).toBe(true);
    const disabled = await set({ component: { kind: 'path' }, enabled: false });
    expect(disabled.ok).toBe(true);
    expect(disabled.status.path.installed).toBe(false);
    expect(path.calls).toEqual(['install', 'uninstall']);
  });

  test('skill toggles route with the enabled flag; unknown ids are refused', async () => {
    const skills = makeSkills(['discovery']);
    const { set } = setup({ skills });
    const off = await set({ component: { kind: 'skill', id: 'discovery' }, enabled: false });
    expect(off.ok).toBe(true);
    expect(off.status.skills.find((s) => s.id === 'discovery')?.installed).toBe(false);
    expect(skills.calls).toEqual([['discovery', false]]);

    const unknown = await set({ component: { kind: 'skill', id: 'nope' }, enabled: true });
    expect(unknown.ok).toBe(false);
  });
});

describe('ok:integrations:dispatch — gates and serialization', () => {
  test('available: false refuses mutations but still reports status', async () => {
    const cli = makeCli();
    const { set, status } = setup({ available: false, cli });
    const snapshot = await status();
    expect(snapshot.available).toBe(false);
    const result = await set({ component: { kind: 'editor', id: 'claude' }, enabled: true });
    expect(result.ok).toBe(false);
    expect(cli.writes).toEqual([]);
  });

  test('concurrent mutations serialize in arrival order', async () => {
    const order: string[] = [];
    const path = makePath();
    let releaseFirst: () => void = () => {};
    path.install = async () => {
      order.push('install-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('install-end');
      return { ok: true };
    };
    path.uninstall = async () => {
      order.push('uninstall');
      return { ok: true };
    };
    const { set } = setup({ path });
    const first = set({ component: { kind: 'path' }, enabled: true });
    const second = set({ component: { kind: 'path' }, enabled: false });
    // Give the first mutation a tick to start, then release it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['install-start', 'install-end', 'uninstall']);
  });

  test('a failed mutation still leaves the chain usable for the next one', async () => {
    const path = makePath();
    path.install = async () => {
      throw new Error('boom');
    };
    const { set } = setup({ path });
    const failed = await set({ component: { kind: 'path' }, enabled: true });
    expect(failed.ok).toBe(false);
    const next = await set({ component: { kind: 'path' }, enabled: false });
    expect(next.ok).toBe(true);
  });

  test('destroy removes the handler; a second destroy is a no-op', () => {
    const { ipcMain, handle } = setup();
    expect(ipcMain.handlers.has('ok:integrations:dispatch')).toBe(true);
    handle.destroy();
    expect(ipcMain.handlers.has('ok:integrations:dispatch')).toBe(false);
    handle.destroy();
  });
});
