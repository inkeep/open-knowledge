/**
 * Settings → AI tools — persistent IPC surface for per-component
 * install/uninstall of OpenKnowledge's GLOBAL footprint: per-editor user-scope
 * MCP entries, the shell-PATH shim, and the user-global skill bundles.
 *
 * Sibling of the one-shot first-launch consent flow (`mcp-wiring.ts`): the
 * dialog solicits a batched decision once; this surface reflects live state
 * (checked = actually installed) and applies one component per invoke, for the
 * lifetime of the app. Same install actors underneath — `writeUserMcpConfigs`,
 * `ensureCliOnPath`, the decision-gated skill reclaim — so the two surfaces
 * can never disagree about what an install means.
 *
 * Mutations serialize through a promise-chain mutex: two windows toggling
 * concurrently (or a rage-click) queue rather than interleave partial writes
 * on the same config file.
 *
 * Electron-free, dependency-injected (mirrors `mcp-wiring.ts`) so bun-test
 * loads it without an Electron runtime; `main/index.ts` wires the real
 * surfaces in.
 */

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

/** Per-editor removal outcome — mirrors the CLI's `McpRemoveOutcome` kinds so
 *  the injected surface can pass the CLI result straight through. */
interface IntegrationsRemoveOutcome {
  kind: 'removed' | 'not-present' | 'left-foreign' | 'declined';
}

/** CLI-side surface (backed by `@inkeep/open-knowledge`). */
export interface IntegrationsCliSurface {
  allEditorIds: readonly McpWiringEditorId[];
  editorLabel(editorId: McpWiringEditorId): string;
  detectInstalledEditors(cwd: string, home?: string): McpWiringEditorId[];
  /** Discriminated read of the editor's user config — never throws for the
   *  expected absent/no-entry/decline cases. */
  classifyExistingMcpEntry(
    editorId: McpWiringEditorId,
    home: string,
  ): { kind: 'absent' | 'no-entry' | 'decline' } | { kind: 'present'; entry: unknown };
  /** True when `entry` is recognizably OK's OWN managed entry (the only
   *  shape uninstall will delete). */
  isOwnEntry(entry: unknown): boolean;
  /** Tildified user-config path for the row's disclosure tooltip; null when
   *  the resolver can't produce one on this platform. */
  editorConfigPath(editorId: McpWiringEditorId): string | null;
  /** Technical locator of OK's entry inside the config (json dotted path or
   *  toml table header) — disclosure only. */
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

/** PATH-shim surface (backed by `path-install.ts`). */
export interface IntegrationsPathSurface {
  computeStatus(): IntegrationsPathStatus;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  uninstall(): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** User-global skills surface (backed by skill-state + skill-reclaim). */
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
  /** Same gate set as the consent dialog / startup reclaim (darwin, packaged
   *  or OK_M6B_FORCE, `.app` executable shape). False renders the section
   *  read-only: status still computes, mutations refuse. */
  available: boolean;
  ipcMain: IpcMainLike;
  cli: IntegrationsCliSurface;
  path: IntegrationsPathSurface;
  skills: IntegrationsSkillsSurface;
  fs?: McpWiringFsOps;
  now?: () => Date;
  logger?: IntegrationsLogger;
}

export interface IntegrationsSettingsHandle {
  destroy(): void;
}

/** Map one editor's config classification to the Settings row state. */
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

export function registerIntegrationsSettings(
  opts: RegisterIntegrationsSettingsOpts,
): IntegrationsSettingsHandle {
  const { home, available, ipcMain, cli, path, skills, fs, now, logger = DEFAULT_LOGGER } = opts;
  const nowDate = (): Date => (now ? now() : new Date());

  function computeEditorStatuses(): IntegrationsEditorStatus[] {
    let detected: Set<McpWiringEditorId>;
    try {
      detected = new Set(cli.detectInstalledEditors('', home));
    } catch {
      detected = new Set();
    }
    return cli.allEditorIds.map((id) => {
      let state: IntegrationsEditorState;
      try {
        state = classifyEditorState(cli.classifyExistingMcpEntry(id, home), cli.isOwnEntry);
      } catch (err) {
        // A throwing read (platform-mismatched config resolver, EACCES) must
        // not take the whole section down — surface the row as unmanageable.
        logger.warn('editor classify failed', {
          id,
          err,
        });
        state = 'unmanageable';
      }
      return {
        id,
        label: cli.editorLabel(id),
        detected: detected.has(id),
        state,
        configPath: cli.editorConfigPath(id),
        entryLocator: cli.editorEntryLocator(id),
      };
    });
  }

  function computeStatus(): IntegrationsStatus {
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
    return { available, editors: computeEditorStatuses(), path: pathStatus, skills: skillStatuses };
  }

  /**
   * Keep the first-launch marker's editor list truthful after a
   * settings-driven toggle. Only when a marker already EXISTS — its absence
   * means "no prior decision", which must keep firing the first-launch
   * dialog; a settings toggle on a marker-less install (possible only when
   * the consent dialog never delivered) doesn't claim that decision.
   */
  function refreshMarkerEditors(): void {
    const marker = readMcpStatusMarker(home, fs);
    if (marker === null) return;
    const installed = computeEditorStatuses()
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
      // Bookkeeping only — the entry write itself already succeeded, and the
      // startup repair scans configs directly rather than trusting the list.
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
          refreshMarkerEditors();
          logger.event({ event: 'integrations-editor-installed', editor: id });
          return { ok: true };
        case 'declined':
          return {
            ok: false,
            error: `Couldn't safely edit ${label}'s config — it was left unchanged.`,
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
        refreshMarkerEditors();
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

  // Promise-chain mutex: mutations run strictly one at a time, in arrival
  // order. Failures don't break the chain (each link swallows into a result).
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
        return { ok: false, error: result.error, status: computeStatus() };
      }
      return { ok: true, status: computeStatus() };
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
