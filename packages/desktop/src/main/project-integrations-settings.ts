/**
 * Settings → This project → AI tools — persistent IPC surface for per-component
 * install/uninstall of OpenKnowledge's PROJECT-LOCAL footprint: the per-editor
 * project MCP config files (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`,
 * …) and the project runtime skill (`.claude/skills/open-knowledge/`, …), all
 * scoped to the project the requesting window has open.
 *
 * The project-scoped sibling of `integrations-settings.ts` (which owns the
 * user-global footprint: user-scope MCP entries, the shell-PATH shim, the
 * user-global skill bundles). Both promote a one-shot consent flow into a
 * persistent, live-state Settings surface; this one mirrors the per-project
 * onboarding dialog (`consent-dialog.ts`) rather than the global first-launch
 * one. Same install actors underneath — `writeEditorMcpConfig` /
 * `removeOwnMcpEntry` / `writeProjectSkill` / `removeProjectSkill` with a
 * project config-path override — so the two surfaces and the reclaim-on-open
 * sweep can never disagree about what a project install means.
 *
 * Two things the global surface does not need:
 *   1. The active project. Every request resolves the sender window's project
 *      dir via the injected `resolveProjectDir(event)` (main maps webContents →
 *      ProjectContext) so the renderer can never target a foreign directory.
 *   2. Per-editor follow-up honesty. A written project config is not always a
 *      connected one — Claude Code needs a one-time approval, Cursor sits
 *      silently disabled until manually enabled, Codex auto-connects on a
 *      trusted project. `followUp` carries that per row.
 *
 * Mutations serialize through a promise-chain mutex, same as the global
 * surface. Electron-free + dependency-injected so bun-test loads it without an
 * Electron runtime; `main/index.ts` wires the real surfaces in.
 */

import { relative } from 'node:path';
import type {
  McpDeclineReason,
  McpEntryClassification,
  McpRemoveOutcome,
} from '@inkeep/open-knowledge';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  IntegrationsEditorState,
  McpWiringEditorId,
  ProjectIntegrationsComponentRef,
  ProjectIntegrationsEditorStatus,
  ProjectIntegrationsFollowUp,
  ProjectIntegrationsSetRequest,
  ProjectIntegrationsSetResult,
  ProjectIntegrationsStatus,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { classifyEditorState } from './integrations-settings.ts';
import { logIpcError } from './ipc-log.ts';

/**
 * Post-install manual step, per editor. Product knowledge, not a config
 * property — an editor that writes a project config fine may still need a
 * consent/enable/trust step before OK's tools actually connect. Unlisted
 * editors default to `none`.
 */
const EDITOR_FOLLOW_UP: Partial<Record<McpWiringEditorId, ProjectIntegrationsFollowUp>> = {
  claude: 'approve-once',
  cursor: 'enable-manually',
  codex: 'auto-connect',
};

function followUpFor(id: McpWiringEditorId): ProjectIntegrationsFollowUp {
  return EDITOR_FOLLOW_UP[id] ?? 'none';
}

/** CLI-side surface (backed by `@inkeep/open-knowledge` project primitives). */
export interface ProjectIntegrationsCliSurface {
  allEditorIds: readonly McpWiringEditorId[];
  editorLabel(id: McpWiringEditorId): string;
  /** Absolute project config path, or null when the editor exposes no
   *  project-scope MCP surface (e.g. Claude Desktop). */
  projectConfigPath(id: McpWiringEditorId, projectDir: string): string | null;
  /** Absolute project skill `SKILL.md` path, or null when the editor exposes
   *  no project-scope skill surface. */
  projectSkillPath(id: McpWiringEditorId, projectDir: string): string | null;
  /** Technical locator of OK's entry inside the config — disclosure only. */
  entryLocator(id: McpWiringEditorId): string;
  classifyExistingProjectMcpConfig(
    id: McpWiringEditorId,
    projectDir: string,
    projectPath: string,
  ): McpEntryClassification;
  /** True when `entry` is recognizably OK's OWN managed entry (the only shape
   *  uninstall deletes). */
  isOwnEntry(entry: unknown): boolean;
  writeProjectMcpConfig(opts: { id: McpWiringEditorId; projectDir: string; projectPath: string }): {
    action: 'written' | 'overwritten' | 'declined' | 'failed';
    reason?: McpDeclineReason;
    error?: string;
  };
  removeProjectMcpEntry(
    id: McpWiringEditorId,
    projectDir: string,
    projectPath: string,
  ): McpRemoveOutcome;
  /** The canonical project runtime skill (`.claude/skills/open-knowledge`) is
   *  on disk — the single row's checked state. */
  isProjectSkillInstalled(projectDir: string): boolean;
  writeProjectSkill(
    id: McpWiringEditorId,
    projectDir: string,
  ): { action: 'written' | 'overwritten' | 'skipped-unsupported' | 'failed'; error?: string };
  removeProjectSkill(
    id: McpWiringEditorId,
    projectDir: string,
  ): { action: 'removed' | 'not-present' | 'skipped-unsupported' | 'failed'; error?: string };
}

interface ProjectIntegrationsLogger {
  warn(msg: string, ctx?: object): void;
  event(payload: { event: string; [k: string]: unknown }): void;
}

const DEFAULT_LOGGER: ProjectIntegrationsLogger = {
  warn: (msg, ctx) => console.warn('[project-integrations-settings]', msg, ctx ?? ''),
  event: (payload) => console.warn(JSON.stringify(payload)),
};

interface IpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

export interface RegisterProjectIntegrationsSettingsOpts {
  /** Same gate set as the global surface / reclaim sweep (darwin, packaged or
   *  OK_M6B_FORCE, `.app` executable shape). False renders the section
   *  read-only: status still computes, mutations refuse. */
  available: boolean;
  ipcMain: IpcMainLike;
  cli: ProjectIntegrationsCliSurface;
  /** Resolve the sender window's project dir (main maps webContents →
   *  ProjectContext). Null when the sender isn't bound to a project. */
  resolveProjectDir(event: IpcMainInvokeEvent): string | null;
  /** Tildify the project dir for disclosure display. Defaults to identity. */
  tildify?(path: string): string;
  logger?: ProjectIntegrationsLogger;
}

export interface ProjectIntegrationsSettingsHandle {
  destroy(): void;
}

export function registerProjectIntegrationsSettings(
  opts: RegisterProjectIntegrationsSettingsOpts,
): ProjectIntegrationsSettingsHandle {
  const {
    available,
    ipcMain,
    cli,
    resolveProjectDir,
    tildify = (p) => p,
    logger = DEFAULT_LOGGER,
  } = opts;

  /** Editors that expose a project skill surface, in registry order. */
  function editorsWithProjectSkill(projectDir: string): McpWiringEditorId[] {
    return cli.allEditorIds.filter((id) => cli.projectSkillPath(id, projectDir) !== null);
  }

  function computeEditorStatuses(projectDir: string): ProjectIntegrationsEditorStatus[] {
    const statuses: ProjectIntegrationsEditorStatus[] = [];
    for (const id of cli.allEditorIds) {
      const projectPath = cli.projectConfigPath(id, projectDir);
      if (projectPath === null) continue; // No project surface → no row.
      let state: IntegrationsEditorState;
      try {
        state = classifyEditorState(
          cli.classifyExistingProjectMcpConfig(id, projectDir, projectPath),
          cli.isOwnEntry,
        );
      } catch (err) {
        // A throwing read (EACCES, a resolver that can't produce a path) must
        // not take the whole section down — surface the row as unmanageable.
        logger.warn('project editor classify failed', {
          projectDir,
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        state = 'unmanageable';
      }
      statuses.push({
        id,
        label: cli.editorLabel(id),
        state,
        configPath: relative(projectDir, projectPath),
        entryLocator: cli.entryLocator(id),
        followUp: followUpFor(id),
      });
    }
    return statuses;
  }

  function computeStatus(projectDir: string | null): ProjectIntegrationsStatus {
    if (projectDir === null) {
      return { available, hasProject: false, projectDir: null, editors: [], skill: null };
    }
    let editors: ProjectIntegrationsEditorStatus[];
    try {
      editors = computeEditorStatuses(projectDir);
    } catch (err) {
      logger.warn('project editor statuses failed', {
        projectDir,
        error: err instanceof Error ? err.message : String(err),
      });
      editors = [];
    }
    const skillPaths = editorsWithProjectSkill(projectDir)
      .map((id) => cli.projectSkillPath(id, projectDir))
      .filter((p): p is string => p !== null)
      .map((p) => relative(projectDir, p));
    let skill: ProjectIntegrationsStatus['skill'] = null;
    if (skillPaths.length > 0) {
      let installed = false;
      try {
        installed = cli.isProjectSkillInstalled(projectDir);
      } catch (err) {
        logger.warn('project skill status failed', {
          projectDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      skill = { installed, paths: skillPaths };
    }
    return { available, hasProject: true, projectDir: tildify(projectDir), editors, skill };
  }

  async function setEditor(
    projectDir: string,
    id: McpWiringEditorId,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const label = cli.editorLabel(id);
    const projectPath = cli.projectConfigPath(id, projectDir);
    if (projectPath === null) {
      return { ok: false, error: `${label} has no project-scope MCP config.` };
    }
    if (enabled) {
      let result: ReturnType<ProjectIntegrationsCliSurface['writeProjectMcpConfig']>;
      try {
        result = cli.writeProjectMcpConfig({ id, projectDir, projectPath });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      switch (result.action) {
        case 'written':
        case 'overwritten':
          logger.event({ event: 'project-integrations-editor-installed', editor: id });
          return { ok: true };
        case 'declined':
          return {
            ok: false,
            error: `Couldn't safely edit ${label}'s project config — it was left unchanged.`,
          };
        default:
          return {
            ok: false,
            error: `Couldn't add OpenKnowledge to ${label}${result.error ? ` (${result.error})` : ''}.`,
          };
      }
    }
    let outcome: McpRemoveOutcome;
    try {
      outcome = cli.removeProjectMcpEntry(id, projectDir, projectPath);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    switch (outcome.kind) {
      case 'removed':
      case 'not-present':
        logger.event({
          event: 'project-integrations-editor-removed',
          editor: id,
          outcome: outcome.kind,
        });
        return { ok: true };
      case 'left-foreign':
        return {
          ok: false,
          error: `The open-knowledge entry in ${label}'s project config isn't one OpenKnowledge wrote — it was left unchanged. Remove it manually if you no longer want it.`,
        };
      case 'declined':
        return {
          ok: false,
          error: `Couldn't safely edit ${label}'s project config — it was left unchanged.`,
        };
    }
  }

  async function setSkill(
    projectDir: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const editors = editorsWithProjectSkill(projectDir);
    if (editors.length === 0) {
      return { ok: false, error: 'No installed editor supports a project skill.' };
    }
    const failures: string[] = [];
    for (const id of editors) {
      try {
        const result = enabled
          ? cli.writeProjectSkill(id, projectDir)
          : cli.removeProjectSkill(id, projectDir);
        if (result.action === 'failed') {
          failures.push(`${cli.editorLabel(id)}${result.error ? ` (${result.error})` : ''}`);
        }
      } catch (err) {
        failures.push(
          `${cli.editorLabel(id)} (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    if (failures.length > 0) {
      return {
        ok: false,
        error: `Couldn't ${enabled ? 'install' : 'remove'} the project skill for: ${failures.join(', ')}.`,
      };
    }
    logger.event({
      event: enabled
        ? 'project-integrations-skill-installed'
        : 'project-integrations-skill-removed',
      editors,
    });
    return { ok: true };
  }

  async function applyComponent(
    projectDir: string | null,
    request: ProjectIntegrationsSetRequest,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!available) {
      return { ok: false, error: 'Managing project AI tools is unavailable in this build.' };
    }
    if (projectDir === null) {
      return { ok: false, error: 'No project is open in this window.' };
    }
    const component = request?.component as ProjectIntegrationsComponentRef | undefined;
    const enabled = request?.enabled === true;
    if (component?.kind === 'editor') {
      if (!cli.allEditorIds.includes(component.id)) {
        return { ok: false, error: 'Unknown editor.' };
      }
      return setEditor(projectDir, component.id, enabled);
    }
    if (component?.kind === 'skill') {
      return setSkill(projectDir, enabled);
    }
    return { ok: false, error: 'Unknown component.' };
  }

  // Promise-chain mutex: mutations run strictly one at a time, in arrival
  // order. Failures don't break the chain (each link swallows into a result).
  let mutationChain: Promise<unknown> = Promise.resolve();

  function dispatchSet(
    projectDir: string | null,
    request: ProjectIntegrationsSetRequest,
  ): Promise<ProjectIntegrationsSetResult> {
    const run = mutationChain.then(async (): Promise<ProjectIntegrationsSetResult> => {
      let result: { ok: true } | { ok: false; error: string };
      try {
        result = await applyComponent(projectDir, request);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!result.ok) {
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:project-integrations:dispatch',
          reason: 'set-component-refused',
          handler: 'projectIntegrationsDispatch',
          cause: { component: request?.component?.kind ?? 'unknown', error: result.error },
        });
        return { ok: false, error: result.error, status: computeStatus(projectDir) };
      }
      return { ok: true, status: computeStatus(projectDir) };
    });
    mutationChain = run.catch(() => {});
    return run;
  }

  const register = createHandler(ipcMain as IpcMain);
  register('ok:project-integrations:dispatch', async (event, request) => {
    let projectDir: string | null;
    try {
      projectDir = resolveProjectDir(event);
    } catch (err) {
      logger.warn('resolveProjectDir threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      projectDir = null;
    }
    if (request?.kind === 'set') return dispatchSet(projectDir, request);
    return computeStatus(projectDir);
  });

  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        ipcMain.removeHandler('ok:project-integrations:dispatch');
      } catch (err) {
        logger.warn('removeHandler(ok:project-integrations:dispatch) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
