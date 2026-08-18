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

/** Per-editor removal outcome — mirrors the CLI's `McpRemoveOutcome` kinds so
 *  the injected surface can pass the CLI result straight through. */
interface IntegrationsRemoveOutcome {
  kind: 'removed' | 'not-present' | 'left-foreign' | 'declined';
}

/** CLI-side surface (backed by `@inkeep/open-knowledge`). */
export interface IntegrationsCliSurface {
  allEditorIds: readonly McpWiringEditorId[];
  editorLabel(editorId: McpWiringEditorId): string;
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
  /** Same gate set as the consent dialog / startup reclaim (a supported
   *  packaged install layout per install-shape.ts, packaged or
   *  OK_M6B_FORCE). False renders the section read-only: status still
   *  computes, mutations refuse. */
  available: boolean;
  ipcMain: IpcMainLike;
  cli: IntegrationsCliSurface;
  /**
   * Unfakeable presence signals for the MCP editor list, injected so main can
   * hand over the probes its launcher surfaces already run and cache rather than
   * spawning a second set. See `detectedEditorsFromProbes` for why a
   * config-directory check cannot stand in for these.
   */
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

/**
 * Raw, unfakeable presence signals, keyed by the id each probe already uses.
 * Every one of these is a fact about the machine that OpenKnowledge cannot
 * write — which is the whole point of taking them instead of reading a config
 * directory back.
 */
export interface EditorPresenceProbes {
  /** Login-shell `command -v <bin>` per terminal CLI. */
  readonly cliOnPath: Readonly<Partial<Record<string, boolean>>>;
  /** OS URL-scheme handler resolution per desktop target (who owns `claude://`). */
  readonly schemeHandler: Readonly<Partial<Record<string, boolean>>>;
}

/**
 * Which editors are actually on this machine.
 *
 * Both signals come from outside OpenKnowledge: a binary resolvable on the
 * user's login-shell PATH, and the application the OS says owns a URL scheme.
 * Neither can be manufactured by writing a directory.
 *
 * That last property is the requirement, not a bonus. Presence must never be
 * inferred from an editor's MCP config directory: OpenKnowledge writes those
 * directories itself (the consent dialog does it for five editors with the
 * availability check bypassed), so reading one back is circular — it reports
 * an editor the user has never installed, and keeps reporting it after the
 * user removes the entry.
 *
 * `lm-studio` is deliberately absent: it ships no CLI and registers no scheme OK
 * can ask about, so there is nothing honest to probe. It reports undetected
 * rather than falling back to the directory check — under-claiming is the safe
 * direction, and no surface prints a presence claim anyway.
 */
export function detectedEditorsFromProbes(probes: EditorPresenceProbes): Set<McpWiringEditorId> {
  const scheme = (id: string): boolean => probes.schemeHandler[id] === true;
  const detected = new Set<McpWiringEditorId>();
  // Gated on the terminal-CLI registry that PRODUCES `cliOnPath`, so adding a
  // CLI there detects it here with no second list to keep in step. The
  // terminal-CLI ids and the editor ids coincide for every host that ships a
  // CLI, which is what lets the key BE the lookup.
  //
  // The gate is load-bearing, not a type formality: `cliOnPath` is keyed by
  // `string`, and an id outside this registry is one OK has no honest CLI
  // signal for — `lm-studio` ships no CLI, so a caller handing us a `true` for
  // it must not turn into a presence claim.
  const cliIds = new Set<string>(TERMINAL_CLI_IDS);
  for (const [id, onPath] of Object.entries(probes.cliOnPath)) {
    if (onPath === true && cliIds.has(id)) detected.add(id as McpWiringEditorId);
  }
  // Desktop apps: the scheme handler is the only signal, and `claude-code` is
  // the handoff-target id for the Claude desktop app.
  if (scheme('claude-code')) {
    detected.add('claude-desktop' as McpWiringEditorId);
    // The CLI and the desktop app are separate installs; either proves Claude.
    detected.add('claude' as McpWiringEditorId);
  }
  if (scheme('codex')) detected.add('codex' as McpWiringEditorId);
  if (scheme('cursor')) detected.add('cursor' as McpWiringEditorId);
  return detected;
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

  /**
   * Every editor with a host root on this machine. The injected probes answer
   * for the machine, not for a directory — there is no project to scope them
   * to, and the Create-new-project dialog reads this off the status snapshot
   * before its project exists. NOT narrowed by `cli.allEditorIds`: that list is
   * filtered to user-global targets, while this set must stay honest about
   * project-scope-only ones (Pi) too.
   */
  async function computeDetectedEditors(): Promise<Set<McpWiringEditorId>> {
    try {
      return detectedEditorsFromProbes(await probeEditorPresence());
    } catch {
      // A failed probe is unknown, not empty-and-not-installed — but unknown
      // must not claim, and an empty set under-claims, which is the safe
      // direction on every surface that reads this.
      return new Set();
    }
  }

  /**
   * `detected` is optional so a caller that has already probed can pass its set
   * in rather than paying a second pass. `probeEditorPresence` is not cached —
   * each call re-runs the login-shell lookups and the OS scheme-handler
   * queries — and two passes can straddle an install or removal, which is
   * exactly the drift the status snapshot must not show.
   */
  async function computeEditorStatuses(
    detected?: Set<McpWiringEditorId>,
  ): Promise<IntegrationsEditorStatus[]> {
    const resolved = detected ?? (await computeDetectedEditors());
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
    // One probe pass feeds both fields — same question, and letting them drift
    // would put the settings list and the create-project dialog on different
    // answers about the same machine.
    const detected = await computeDetectedEditors();
    return {
      available,
      editors: await computeEditorStatuses(detected),
      path: pathStatus,
      skills: skillStatuses,
      detectedEditorIds: [...detected],
    };
  }

  /**
   * Keep the first-launch marker's editor list truthful after a
   * settings-driven toggle. Only when a marker already EXISTS — its absence
   * means "no prior decision", which must keep firing the first-launch
   * dialog; a settings toggle on a marker-less install (possible only when
   * the consent dialog never delivered) doesn't claim that decision.
   */
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
          await refreshMarkerEditors();
          logger.event({ event: 'integrations-editor-installed', editor: id });
          return { ok: true };
        case 'declined':
          return {
            ok: false,
            error: `Couldn't safely edit ${label}'s config — it was left unchanged.`,
          };
        case 'skipped-missing':
          // The editor's config dir doubles as its detection probe, so writing
          // would create the very directory OK later reads back as "installed"
          // — the write is refused rather than fabricating that evidence. Every
          // row here keeps a live checkbox regardless of detection, so this is
          // reachable by design; say the tool is missing rather than blaming OK
          // for a failure. The row's own `How to set up` link covers what next.
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
