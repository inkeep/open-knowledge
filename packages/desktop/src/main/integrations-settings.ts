import { TERMINAL_CLI_IDS } from '@inkeep/open-knowledge-core';
import type { IpcMain } from 'electron';
import type {
  IntegrationsComponentRef,
  IntegrationsEditorState,
  IntegrationsEditorStatus,
  IntegrationsPathStatus,
  IntegrationsSetRequest,
  IntegrationsSetResult,
  IntegrationsSkillStatus,
  IntegrationsStatus,
  McpWiringEditorId,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { logIpcError } from './ipc-log.ts';
import {
  type McpStatusMarker,
  type McpWiringFsOps,
  readMcpStatusMarker,
  writeMcpStatusMarker,
} from './mcp-wiring.ts';

interface IntegrationsRemoveOutcome {
  kind: 'removed' | 'not-present' | 'left-foreign' | 'declined';
}

export interface IntegrationsCliSurface {
  allEditorIds: readonly McpWiringEditorId[];
  editorLabel(editorId: McpWiringEditorId): string;
  classifyExistingMcpEntry(
    editorId: McpWiringEditorId,
    home: string,
  ): { kind: 'absent' | 'no-entry' | 'decline' } | { kind: 'present'; entry: unknown };
  isOwnEntry(entry: unknown): boolean;
  editorConfigPath(editorId: McpWiringEditorId): string | null;
  editorEntryLocator(editorId: McpWiringEditorId): string;
  writeUserMcpConfigs(opts: { editors: McpWiringEditorId[]; home?: string }): Promise<
    Array<{
      editorId: McpWiringEditorId;
      action:
        | 'written'
        | 'overwritten'
        | 'skipped-missing'
        | 'skipped-flag'
        | 'failed'
        | 'declined';
      error?: string;
    }>
  >;
  removeUserMcpEntry(editorId: McpWiringEditorId): IntegrationsRemoveOutcome;
}

export interface IntegrationsPathSurface {
  computeStatus(): IntegrationsPathStatus;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  uninstall(): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface IntegrationsSkillsSurface {
  computeStatuses(): IntegrationsSkillStatus[];
  setEnabled(
    bundleId: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

interface IntegrationsLogger {
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  event(payload: { event: string; [k: string]: unknown }): void;
}

const DEFAULT_LOGGER: IntegrationsLogger = {
  warn: (msg, ctx) => console.warn('[integrations-settings]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[integrations-settings]', msg, ctx ?? ''),
  event: (payload) => console.warn(JSON.stringify(payload)),
};

interface IpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

export interface RegisterIntegrationsSettingsOpts {
  home: string;
  available: boolean;
  ipcMain: IpcMainLike;
  cli: IntegrationsCliSurface;
  probeEditorPresence: () => Promise<EditorPresenceProbes>;
  path: IntegrationsPathSurface;
  skills: IntegrationsSkillsSurface;
  fs?: McpWiringFsOps;
  now?: () => Date;
  logger?: IntegrationsLogger;
}

export interface IntegrationsSettingsHandle {
  destroy(): void;
}

export function classifyEditorState(
  classification: ReturnType<IntegrationsCliSurface['classifyExistingMcpEntry']>,
  isOwnEntry: (entry: unknown) => boolean,
): IntegrationsEditorState {
  switch (classification.kind) {
    case 'absent':
    case 'no-entry':
      return 'not-installed';
    case 'decline':
      return 'unmanageable';
    case 'present':
      return isOwnEntry(classification.entry) ? 'installed' : 'foreign';
  }
}

export interface EditorPresenceProbes {
  readonly cliOnPath: Readonly<Partial<Record<string, boolean>>>;
  readonly schemeHandler: Readonly<Partial<Record<string, boolean>>>;
}

export function detectedEditorsFromProbes(probes: EditorPresenceProbes): Set<McpWiringEditorId> {
  const scheme = (id: string): boolean => probes.schemeHandler[id] === true;
  const detected = new Set<McpWiringEditorId>();
  const cliIds = new Set<string>(TERMINAL_CLI_IDS);
  for (const [id, onPath] of Object.entries(probes.cliOnPath)) {
    if (onPath === true && cliIds.has(id)) detected.add(id as McpWiringEditorId);
  }
  if (scheme('claude-code')) {
    detected.add('claude-desktop' as McpWiringEditorId);
    detected.add('claude' as McpWiringEditorId);
  }
  if (scheme('codex')) detected.add('codex' as McpWiringEditorId);
  if (scheme('cursor')) detected.add('cursor' as McpWiringEditorId);
  return detected;
}

export async function safeDetectedEditors(
  probeEditorPresence: () => Promise<EditorPresenceProbes>,
): Promise<Set<McpWiringEditorId>> {
  try {
    return detectedEditorsFromProbes(await probeEditorPresence());
  } catch {
    return new Set();
  }
}

export function registerIntegrationsSettings(
  opts: RegisterIntegrationsSettingsOpts,
): IntegrationsSettingsHandle {
  const {
    home,
    available,
    ipcMain,
    cli,
    probeEditorPresence,
    path,
    skills,
    fs,
    now,
    logger = DEFAULT_LOGGER,
  } = opts;
  const nowDate = (): Date => (now ? now() : new Date());

  const computeDetectedEditors = (): Promise<Set<McpWiringEditorId>> =>
    safeDetectedEditors(probeEditorPresence);

  async function computeEditorStatuses(
    detected?: Set<McpWiringEditorId>,
  ): Promise<IntegrationsEditorStatus[]> {
    const resolved = detected ?? (await computeDetectedEditors());
    return cli.allEditorIds.map((id) => {
      let state: IntegrationsEditorState;
      try {
        state = classifyEditorState(cli.classifyExistingMcpEntry(id, home), cli.isOwnEntry);
      } catch (err) {
        logger.warn('editor classify failed', {
          id,
          err,
        });
        state = 'unmanageable';
      }
      return {
        id,
        label: cli.editorLabel(id),
        detected: resolved.has(id),
        state,
        configPath: cli.editorConfigPath(id),
        entryLocator: cli.editorEntryLocator(id),
      };
    });
  }

  async function computeStatus(): Promise<IntegrationsStatus> {
    let pathStatus: IntegrationsPathStatus;
    try {
      pathStatus = path.computeStatus();
    } catch (err) {
      logger.warn('path status failed', {
        err,
      });
      pathStatus = { shellDetected: false, rcFilesToTouch: [], installed: false };
    }
    let skillStatuses: IntegrationsSkillStatus[];
    try {
      skillStatuses = skills.computeStatuses();
    } catch (err) {
      logger.warn('skill statuses failed', {
        err,
      });
      skillStatuses = [];
    }
    const detected = await computeDetectedEditors();
    return {
      available,
      editors: await computeEditorStatuses(detected),
      path: pathStatus,
      skills: skillStatuses,
      detectedEditorIds: [...detected],
    };
  }

  async function refreshMarkerEditors(): Promise<void> {
    const marker = readMcpStatusMarker(home, fs);
    if (marker === null) return;
    const installed = (await computeEditorStatuses())
      .filter((e) => e.state === 'installed')
      .map((e) => e.id);
    const next: McpStatusMarker = {
      configured: true,
      configuredAt: marker.configured === true ? marker.configuredAt : nowDate().toISOString(),
      editors: installed,
    };
    try {
      writeMcpStatusMarker(home, next, fs);
    } catch (err) {
      logger.warn('marker refresh failed', {
        err,
      });
    }
  }

  async function setEditor(
    id: McpWiringEditorId,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const label = cli.editorLabel(id);
    if (enabled) {
      let results: Awaited<ReturnType<IntegrationsCliSurface['writeUserMcpConfigs']>>;
      try {
        results = await cli.writeUserMcpConfigs({ editors: [id], home });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const result = results.find((r) => r.editorId === id);
      if (!result) return { ok: false, error: `No write result for ${label}.` };
      switch (result.action) {
        case 'written':
        case 'overwritten':
          await refreshMarkerEditors();
          logger.event({ event: 'integrations-editor-installed', editor: id });
          return { ok: true };
        case 'declined':
          return {
            ok: false,
            error: `Couldn't safely edit ${label}'s config — it was left unchanged.`,
          };
        case 'skipped-missing':
          return {
            ok: false,
            error: `${label} wasn't found on this machine. Install it first, then connect it here.`,
          };
        default:
          return {
            ok: false,
            error: `Couldn't add OpenKnowledge to ${label}${result.error ? ` (${result.error})` : ''}.`,
          };
      }
    }
    let outcome: IntegrationsRemoveOutcome;
    try {
      outcome = cli.removeUserMcpEntry(id);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    switch (outcome.kind) {
      case 'removed':
      case 'not-present':
        await refreshMarkerEditors();
        logger.event({ event: 'integrations-editor-removed', editor: id, outcome: outcome.kind });
        return { ok: true };
      case 'left-foreign':
        return {
          ok: false,
          error: `The open-knowledge entry in ${label} isn't one OpenKnowledge wrote — it was left unchanged. Remove it manually if you no longer want it.`,
        };
      case 'declined':
        return {
          ok: false,
          error: `Couldn't safely edit ${label}'s config — it was left unchanged.`,
        };
    }
  }

  async function applyComponent(
    request: IntegrationsSetRequest,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!available) {
      return { ok: false, error: 'Managing AI tools is unavailable in this build.' };
    }
    const component = request?.component as IntegrationsComponentRef | undefined;
    const enabled = request?.enabled === true;
    if (component?.kind === 'editor') {
      if (!cli.allEditorIds.includes(component.id)) {
        return { ok: false, error: 'Unknown editor.' };
      }
      return setEditor(component.id, enabled);
    }
    if (component?.kind === 'path') {
      return enabled ? path.install() : path.uninstall();
    }
    if (component?.kind === 'skill') {
      const known = skills.computeStatuses().some((s) => s.id === component.id);
      if (!known) return { ok: false, error: 'Unknown skill.' };
      return skills.setEnabled(component.id, enabled);
    }
    return { ok: false, error: 'Unknown component.' };
  }

  let mutationChain: Promise<unknown> = Promise.resolve();

  function dispatchSet(request: IntegrationsSetRequest): Promise<IntegrationsSetResult> {
    const run = mutationChain.then(async (): Promise<IntegrationsSetResult> => {
      let result: { ok: true } | { ok: false; error: string };
      try {
        result = await applyComponent(request);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!result.ok) {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:integrations:dispatch',
          reason: 'set-component-refused',
          handler: 'integrationsDispatch',
          cause: { component: request?.component?.kind ?? 'unknown', error: result.error },
        });
        return { ok: false, error: result.error, status: await computeStatus() };
      }
      return { ok: true, status: await computeStatus() };
    });
    mutationChain = run.catch(() => {});
    return run;
  }

  const register = createHandler(ipcMain as IpcMain);
  register('ok:integrations:dispatch', async (_event, request) => {
    if (request?.kind === 'set') return dispatchSet(request);
    return computeStatus();
  });

  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        ipcMain.removeHandler('ok:integrations:dispatch');
      } catch (err) {
        logger.warn('removeHandler(ok:integrations:dispatch) threw', {
          err,
        });
      }
    },
  };
}
