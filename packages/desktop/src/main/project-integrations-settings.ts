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
  SkillCostTiers,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import {
  classifyEditorState,
  type EditorPresenceProbes,
  safeDetectedEditors,
} from './integrations-settings.ts';
import { logIpcError } from './ipc-log.ts';

const EDITOR_FOLLOW_UP: Partial<Record<McpWiringEditorId, ProjectIntegrationsFollowUp>> = {
  claude: 'approve-once',
  cursor: 'enable-manually',
  codex: 'auto-connect',
};

function followUpFor(id: McpWiringEditorId): ProjectIntegrationsFollowUp {
  return EDITOR_FOLLOW_UP[id] ?? 'none';
}

export interface ProjectIntegrationsCliSurface {
  allEditorIds: readonly McpWiringEditorId[];
  editorLabel(id: McpWiringEditorId): string;
  projectConfigPath(id: McpWiringEditorId, projectDir: string): string | null;
  projectSkillPath(id: McpWiringEditorId, projectDir: string): string | null;
  projectSkillBundle(): {
    sourceDir: string;
    description: string;
    size?: SkillCostTiers;
  } | null;
  entryLocator(id: McpWiringEditorId): string;
  classifyExistingProjectMcpConfig(
    id: McpWiringEditorId,
    projectDir: string,
    projectPath: string,
  ): McpEntryClassification;
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
  isProjectSkillInstalled(projectDir: string): boolean;
  writeProjectSkill(
    id: McpWiringEditorId,
    projectDir: string,
  ): {
    action: 'written' | 'overwritten' | 'skipped-unsupported' | 'skipped-prerequisite' | 'failed';
    error?: string;
  };
  removeProjectSkill(
    id: McpWiringEditorId,
    projectDir: string,
  ): { action: 'removed' | 'not-present' | 'skipped-unsupported' | 'failed'; error?: string };
  recordProjectSkillDecision?(projectDir: string, enabled: boolean): void;
  reportProjectSkillInstalled?(projectDir: string): void;
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
  available: boolean;
  ipcMain: IpcMainLike;
  cli: ProjectIntegrationsCliSurface;
  probeEditorPresence: () => Promise<EditorPresenceProbes>;
  resolveProjectDir(event: IpcMainInvokeEvent): string | null;
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
    probeEditorPresence,
    resolveProjectDir,
    tildify = (p) => p,
    logger = DEFAULT_LOGGER,
  } = opts;

  function editorsWithProjectSkill(projectDir: string): McpWiringEditorId[] {
    return cli.allEditorIds.filter((id) => cli.projectSkillPath(id, projectDir) !== null);
  }

  function computeEditorStatuses(
    projectDir: string,
    detected: ReadonlySet<McpWiringEditorId>,
  ): ProjectIntegrationsEditorStatus[] {
    const statuses: ProjectIntegrationsEditorStatus[] = [];
    for (const id of cli.allEditorIds) {
      const projectPath = cli.projectConfigPath(id, projectDir);
      if (projectPath === null) continue;
      let state: IntegrationsEditorState;
      try {
        state = classifyEditorState(
          cli.classifyExistingProjectMcpConfig(id, projectDir, projectPath),
          cli.isOwnEntry,
        );
      } catch (err) {
        logger.warn('project editor classify failed', {
          projectDir,
          id,
          err,
        });
        state = 'unmanageable';
      }
      statuses.push({
        id,
        label: cli.editorLabel(id),
        detected: detected.has(id),
        state,
        configPath: relative(projectDir, projectPath),
        entryLocator: cli.entryLocator(id),
        followUp: followUpFor(id),
      });
    }
    return statuses;
  }

  async function computeStatus(projectDir: string | null): Promise<ProjectIntegrationsStatus> {
    if (projectDir === null) {
      return { available, hasProject: false, projectDir: null, editors: [], skill: null };
    }
    let editors: ProjectIntegrationsEditorStatus[];
    try {
      editors = computeEditorStatuses(projectDir, await safeDetectedEditors(probeEditorPresence));
    } catch (err) {
      logger.warn('project editor statuses failed', {
        projectDir,
        err,
      });
      editors = [];
    }
    const skillHosts = editorsWithProjectSkill(projectDir).filter(
      (id) => cli.projectSkillPath(id, projectDir) !== null,
    );
    const skillPaths = skillHosts
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
          err,
        });
      }
      let bundle: ReturnType<ProjectIntegrationsCliSurface['projectSkillBundle']> = null;
      try {
        bundle = cli.projectSkillBundle();
      } catch (err) {
        logger.warn('project skill bundle read failed', { err });
      }
      skill = {
        installed,
        paths: skillPaths,
        hosts: skillHosts,
        description: bundle?.description ?? '',
        ...(bundle?.size ? { size: bundle.size } : {}),
        ...(bundle?.sourceDir ? { sourceDir: bundle.sourceDir } : {}),
      };
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
    cli.recordProjectSkillDecision?.(projectDir, enabled);
    if (enabled && failures.length === 0) cli.reportProjectSkillInstalled?.(projectDir);
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
        return { ok: false, error: result.error, status: await computeStatus(projectDir) };
      }
      return { ok: true, status: await computeStatus(projectDir) };
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
        err,
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
          err,
        });
      }
    },
  };
}
