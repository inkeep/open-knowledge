import type { McpEntryClassification } from '@inkeep/open-knowledge';
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, test } from 'vitest';
import type {
  McpWiringEditorId,
  ProjectIntegrationsSetRequest,
  ProjectIntegrationsSetResult,
  ProjectIntegrationsStatus,
} from '../shared/ipc-channels.ts';
import {
  type ProjectIntegrationsCliSurface,
  registerProjectIntegrationsSettings,
} from './project-integrations-settings.ts';

const PROJECT = '/proj';
const EVENT = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

const OWN_ENTRY = { own: true };
const FOREIGN_ENTRY = { own: false };

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  };
}

interface CliOverrides {
  classifications?: Partial<Record<McpWiringEditorId, McpEntryClassification>>;
  writeAction?: 'written' | 'overwritten' | 'declined' | 'failed';
  removeKind?: 'removed' | 'not-present' | 'left-foreign' | 'declined';
  skillInstalled?: boolean;
  skillWriteFails?: McpWiringEditorId[];
  skillRemoveFails?: McpWiringEditorId[];
}

function makeCli(overrides: CliOverrides = {}): ProjectIntegrationsCliSurface & {
  writes: McpWiringEditorId[];
  removals: McpWiringEditorId[];
  skillWrites: McpWiringEditorId[];
  skillRemovals: McpWiringEditorId[];
  decisions: Array<{ dir: string; enabled: boolean }>;
  reports: string[];
} {
  const writes: McpWiringEditorId[] = [];
  const decisions: Array<{ dir: string; enabled: boolean }> = [];
  const reports: string[] = [];
  const removals: McpWiringEditorId[] = [];
  const skillWrites: McpWiringEditorId[] = [];
  const skillRemovals: McpWiringEditorId[] = [];
  const CONFIG: Partial<Record<string, string>> = {
    claude: '.mcp.json',
    codex: '.codex/config.toml',
  };
  const SKILL: Partial<Record<string, string>> = {
    claude: '.claude/skills/open-knowledge/SKILL.md',
    codex: '.codex/skills/open-knowledge/SKILL.md',
  };
  return {
    writes,
    removals,
    skillWrites,
    skillRemovals,
    allEditorIds: ['claude', 'codex', 'claude-desktop'] as McpWiringEditorId[],
    editorLabel: (id) => id,
    projectConfigPath: (id, projectDir) => (CONFIG[id] ? `${projectDir}/${CONFIG[id]}` : null),
    projectSkillPath: (id, projectDir) => (SKILL[id] ? `${projectDir}/${SKILL[id]}` : null),
    projectSkillBundle: () => ({
      sourceDir: '/bundled/project',
      description: 'Teaches coding agents in this project.',
      size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
    }),
    entryLocator: (id) =>
      id === 'codex' ? '[mcp_servers.open-knowledge]' : 'mcpServers.open-knowledge',
    classifyExistingProjectMcpConfig: (id) =>
      overrides.classifications?.[id] ?? ({ kind: 'no-entry' } as McpEntryClassification),
    isOwnEntry: (entry) => entry === OWN_ENTRY,
    writeProjectMcpConfig: ({ id }) => {
      writes.push(id);
      const action = overrides.writeAction ?? 'written';
      if (action === 'failed') return { action: 'failed', error: 'disk full' };
      if (action === 'declined') return { action: 'declined', reason: 'unparseable' };
      return { action };
    },
    removeProjectMcpEntry: (id) => {
      removals.push(id);
      return { kind: overrides.removeKind ?? 'removed' } as ReturnType<
        ProjectIntegrationsCliSurface['removeProjectMcpEntry']
      >;
    },
    isProjectSkillInstalled: () => overrides.skillInstalled ?? false,
    writeProjectSkill: (id) => {
      skillWrites.push(id);
      if (overrides.skillWriteFails?.includes(id)) return { action: 'failed', error: 'nope' };
      return { action: 'written' };
    },
    removeProjectSkill: (id) => {
      skillRemovals.push(id);
      if (overrides.skillRemoveFails?.includes(id)) return { action: 'failed', error: 'nope' };
      return { action: 'removed' };
    },
    recordProjectSkillDecision: (dir, enabled) => {
      decisions.push({ dir, enabled });
    },
    reportProjectSkillInstalled: (dir) => {
      reports.push(dir);
    },
    decisions,
    reports,
  };
}

function register(
  cli: ProjectIntegrationsCliSurface,
  opts: {
    available?: boolean;
    projectDir?: string | null;
    probeEditorPresence?: Parameters<
      typeof registerProjectIntegrationsSettings
    >[0]['probeEditorPresence'];
  } = {},
) {
  const ipcMain = fakeIpcMain();
  const handle = registerProjectIntegrationsSettings({
    available: opts.available ?? true,
    ipcMain,
    cli,
    probeEditorPresence:
      opts.probeEditorPresence ?? (async () => ({ cliOnPath: {}, schemeHandler: {} })),
    resolveProjectDir: () => (opts.projectDir === undefined ? PROJECT : opts.projectDir),
    tildify: (p) => p,
  });
  const dispatch = ipcMain.handlers.get('ok:project-integrations:dispatch');
  if (!dispatch) throw new Error('handler not registered');
  return {
    handle,
    ipcMain,
    status: () => dispatch(EVENT, { kind: 'status' }) as Promise<ProjectIntegrationsStatus>,
    set: (request: ProjectIntegrationsSetRequest) =>
      dispatch(EVENT, { kind: 'set', ...request }) as Promise<ProjectIntegrationsSetResult>,
  };
}

describe('registerProjectIntegrationsSettings — status', () => {
  test('omits editors with no project surface; relativizes paths; carries followUp', async () => {
    const { status } = register(makeCli());
    const s = await status();
    expect(s.hasProject).toBe(true);
    expect(s.available).toBe(true);
    expect(s.editors.map((e) => e.id)).toEqual(['claude', 'codex']);
    const claude = s.editors.find((e) => e.id === 'claude');
    expect(claude?.configPath).toBe('.mcp.json');
    expect(claude?.detected).toBe(false);
    expect(claude?.followUp).toBe('approve-once');
    expect(s.editors.find((e) => e.id === 'codex')?.followUp).toBe('auto-connect');
  });

  test('marks project rows detected from the shared machine-level probes', async () => {
    const { status } = register(makeCli(), {
      probeEditorPresence: async () => ({
        cliOnPath: { codex: true },
        schemeHandler: { 'claude-code': true },
      }),
    });
    const s = await status();
    expect(s.editors.map(({ id, detected }) => [id, detected])).toEqual([
      ['claude', true],
      ['codex', true],
    ]);
  });

  test('probe failure safely leaves project rows undetected', async () => {
    const { status } = register(makeCli(), {
      probeEditorPresence: async () => {
        throw new Error('probe unavailable');
      },
    });
    const s = await status();
    expect(s.editors.length).toBeGreaterThan(0);
    expect(s.editors.every((editor) => !editor.detected)).toBe(true);
  });

  test('classifies own entry as installed, foreign as foreign, decline as unmanageable', async () => {
    const { status } = register(
      makeCli({
        classifications: {
          claude: { kind: 'present', entry: OWN_ENTRY } as McpEntryClassification,
          codex: { kind: 'present', entry: FOREIGN_ENTRY } as McpEntryClassification,
        },
      }),
    );
    const s = await status();
    expect(s.editors.find((e) => e.id === 'claude')?.state).toBe('installed');
    expect(s.editors.find((e) => e.id === 'codex')?.state).toBe('foreign');
  });

  test('surfaces a single skill row across capable editors', async () => {
    const { status } = register(makeCli({ skillInstalled: true }));
    const s = await status();
    expect(s.skill?.installed).toBe(true);
    expect(s.skill?.paths).toEqual([
      '.claude/skills/open-knowledge/SKILL.md',
      '.codex/skills/open-knowledge/SKILL.md',
    ]);
  });

  test('no project resolved → empty, hasProject false, still returns', async () => {
    const { status } = register(makeCli(), { projectDir: null });
    const s = await status();
    expect(s.hasProject).toBe(false);
    expect(s.projectDir).toBeNull();
    expect(s.editors).toEqual([]);
    expect(s.skill).toBeNull();
  });
});

describe('registerProjectIntegrationsSettings — set', () => {
  test('editor install writes the config and returns ok', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({
      component: { kind: 'editor', id: 'claude' as McpWiringEditorId },
      enabled: true,
    });
    expect(r.ok).toBe(true);
    expect(cli.writes).toEqual(['claude']);
  });

  test('editor uninstall removes the entry and returns ok', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({
      component: { kind: 'editor', id: 'codex' as McpWiringEditorId },
      enabled: false,
    });
    expect(r.ok).toBe(true);
    expect(cli.removals).toEqual(['codex']);
  });

  test('uninstall of a foreign entry refuses with an explanatory error', async () => {
    const cli = makeCli({ removeKind: 'left-foreign' });
    const { set } = register(cli);
    const r = await set({
      component: { kind: 'editor', id: 'claude' as McpWiringEditorId },
      enabled: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('left unchanged');
  });

  test('the skill row carries reach, cost and source so the consent row can price it', async () => {
    const cli = makeCli();
    const { status } = register(cli);
    const r = await status();
    expect(r.skill).not.toBeNull();
    expect(r.skill?.hosts).toEqual(['claude', 'codex']);
    expect(r.skill?.paths.length).toBe(2);
    expect(r.skill?.size).toEqual({ alwaysOn: 140, onTrigger: 1495, onDemand: 0 });
    expect(r.skill?.sourceDir).toBe('/bundled/project');
    expect(r.skill?.description).toBe('Teaches coding agents in this project.');
  });

  test('an unreadable bundle costs the row its cost line, never the row itself', async () => {
    const cli = makeCli();
    const { status } = register({
      ...cli,
      projectSkillBundle: () => {
        throw new Error('bundled asset missing');
      },
    });
    const r = await status();
    expect(r.skill).not.toBeNull();
    expect(r.skill?.hosts).toEqual(['claude', 'codex']);
    expect(r.skill?.size).toBeUndefined();
    expect(r.skill?.sourceDir).toBeUndefined();
  });

  test('skill install fans out to every capable editor', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: true });
    expect(r.ok).toBe(true);
    expect(cli.skillWrites).toEqual(['claude', 'codex']);
  });

  test('skill install reports the editors that failed', async () => {
    const cli = makeCli({ skillWriteFails: ['codex'] as McpWiringEditorId[] });
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('codex');
  });

  test('skill uninstall fans out removeProjectSkill to every capable editor', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: false });
    expect(r.ok).toBe(true);
    expect(cli.skillRemovals).toEqual(['claude', 'codex']);
    expect(cli.skillWrites).toEqual([]);
  });

  test('switching the skill ON records the decision and counts the install', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: true });
    expect(r.ok).toBe(true);
    expect(cli.decisions).toEqual([{ dir: PROJECT, enabled: true }]);
    expect(cli.reports).toEqual([PROJECT]);
  });

  test('switching the skill OFF records the decision and counts nothing', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: false });
    expect(r.ok).toBe(true);
    expect(cli.decisions).toEqual([{ dir: PROJECT, enabled: false }]);
    expect(cli.reports).toEqual([]);
  });

  test('a partial failure still records the choice but counts no install', async () => {
    const cli = makeCli({ skillWriteFails: ['codex'] as McpWiringEditorId[] });
    const { set } = register(cli);
    await set({ component: { kind: 'skill' }, enabled: true });
    expect(cli.decisions).toEqual([{ dir: PROJECT, enabled: true }]);
    expect(cli.reports).toEqual([]);
  });

  test('skill uninstall reports the editors that failed', async () => {
    const cli = makeCli({ skillRemoveFails: ['codex'] as McpWiringEditorId[] });
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('codex');
    expect(cli.skillRemovals).toEqual(['claude', 'codex']);
  });

  test('editor install surfaces a declined write as a refusal, not success', async () => {
    const cli = makeCli({ writeAction: 'declined' });
    const { set } = register(cli);
    const r = await set({
      component: { kind: 'editor', id: 'claude' as McpWiringEditorId },
      enabled: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('left unchanged');
  });

  test('editor install surfaces a failed write with the failure reason', async () => {
    const cli = makeCli({ writeAction: 'failed' });
    const { set } = register(cli);
    const r = await set({
      component: { kind: 'editor', id: 'claude' as McpWiringEditorId },
      enabled: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Couldn't add");
      expect(r.error).toContain('disk full');
    }
  });

  test('editor uninstall surfaces a declined removal as a refusal', async () => {
    const cli = makeCli({ removeKind: 'declined' });
    const { set } = register(cli);
    const r = await set({
      component: { kind: 'editor', id: 'claude' as McpWiringEditorId },
      enabled: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('left unchanged');
  });

  test('read-only build refuses every mutation', async () => {
    const cli = makeCli();
    const { set } = register(cli, { available: false });
    const r = await set({ component: { kind: 'skill' }, enabled: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unavailable');
    expect(cli.skillWrites).toEqual([]);
  });

  test('mutation with no project open refuses', async () => {
    const cli = makeCli();
    const { set } = register(cli, { projectDir: null });
    const r = await set({
      component: { kind: 'editor', id: 'claude' as McpWiringEditorId },
      enabled: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('No project');
    expect(cli.writes).toEqual([]);
  });

  test('every set result carries a fresh status snapshot', async () => {
    const cli = makeCli();
    const { set } = register(cli);
    const r = await set({ component: { kind: 'skill' }, enabled: true });
    expect(r.status.hasProject).toBe(true);
    expect(r.status.editors.length).toBe(2);
  });
});
