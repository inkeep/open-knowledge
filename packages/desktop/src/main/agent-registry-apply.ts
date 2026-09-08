import {
  type AppliedStep,
  type ApplyErrorId,
  type ApplyReport,
  buildConnectionsView,
  type EditorId,
  EMPTY_DETECTION_SNAPSHOT,
  EMPTY_PROBE_SNAPSHOT,
  type ExecutedOutcome,
  executePlan,
  type HostSnapshot,
  type PlannedStep,
  parsePathId,
  planIntents,
  type SatisfierId,
  type StepExecutor,
} from '@inkeep/open-knowledge-core';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  AgentIntegrationsApplyRequest,
  AgentIntegrationsApplyResult,
  McpWiringEditorId,
} from '../shared/ipc-channels.ts';
import type { IntegrationsCliSurface } from './integrations-settings.ts';
import { logIpcError } from './ipc-log.ts';
import type { ProjectIntegrationsCliSurface } from './project-integrations-settings.ts';

const CHANNEL = 'ok:integrations:dispatch';

export type GlobalWriterSurface = Pick<
  IntegrationsCliSurface,
  | 'allEditorIds'
  | 'writeUserMcpConfigs'
  | 'removeUserMcpEntry'
  | 'writeUserSkill'
  | 'removeUserSkill'
  | 'recordUserSkillDecision'
  | 'userSkillPresentAnywhere'
>;

export type ProjectWriterSurface = Pick<
  ProjectIntegrationsCliSurface,
  | 'projectConfigPath'
  | 'writeProjectMcpConfig'
  | 'removeProjectMcpEntry'
  | 'writeProjectSkill'
  | 'removeProjectSkill'
>;

export interface AgentRegistryWriterSurfaces {
  readonly global: GlobalWriterSurface;
  readonly project: ProjectWriterSurface;
}

function fail(errorId: ApplyErrorId): ExecutedOutcome {
  return { action: 'failed', errorId };
}

function logWriteFailure(
  logger: AgentIntegrationsLogger,
  editor: McpWiringEditorId,
  reason: string | undefined,
): void {
  logger.warn('skill write failed', { channel: CHANNEL, editor, reason: reason ?? '' });
}

function missing(): ExecutedOutcome {
  return { action: 'skipped-missing', errorId: 'surface-missing' };
}

function locationEditor(step: PlannedStep): EditorId | null {
  if (step.pathId === undefined) return null;
  const location = parsePathId(step.pathId);
  if (location === null || location.kind === 'central-skill-store') return null;
  return location.editor;
}

function applyUserMcp(
  global: GlobalWriterSurface,
  editor: McpWiringEditorId,
  desired: PlannedStep['desired'],
): ExecutedOutcome | Promise<ExecutedOutcome> {
  if (!global.allEditorIds.includes(editor)) return missing();

  if (desired === 'absent') {
    switch (global.removeUserMcpEntry(editor).kind) {
      case 'removed':
        return { action: 'removed' };
      case 'not-present':
        return { action: 'no-op' };
      case 'left-foreign':
        return { action: 'skipped-foreign', errorId: 'foreign-artifact' };
      case 'declined':
        return { action: 'declined', errorId: 'write-declined' };
    }
  }

  return global.writeUserMcpConfigs({ editors: [editor] }).then((results) => {
    const result = results.find((entry) => entry.editorId === editor);
    if (result === undefined) return fail('write-failed');
    switch (result.action) {
      case 'written':
      case 'overwritten':
        return { action: result.action };
      case 'declined':
        return { action: 'declined', errorId: 'write-declined' };
      case 'skipped-missing':
        return missing();
      case 'skipped-flag':
        return { action: 'skipped-unsupported', errorId: 'no-writer' };
      case 'failed':
        return fail('write-failed');
    }
  });
}

function applyProjectMcp(
  project: ProjectWriterSurface,
  editor: McpWiringEditorId,
  projectDir: string,
  desired: PlannedStep['desired'],
): ExecutedOutcome {
  const projectPath = project.projectConfigPath(editor, projectDir);
  if (projectPath === null) return missing();

  if (desired === 'absent') {
    switch (project.removeProjectMcpEntry(editor, projectDir, projectPath).kind) {
      case 'removed':
        return { action: 'removed' };
      case 'not-present':
        return { action: 'no-op' };
      case 'left-foreign':
        return { action: 'skipped-foreign', errorId: 'foreign-artifact' };
      case 'declined':
        return { action: 'declined', errorId: 'write-declined' };
    }
  }

  const result = project.writeProjectMcpConfig({ id: editor, projectDir, projectPath });
  switch (result.action) {
    case 'written':
    case 'overwritten':
      return { action: result.action };
    case 'declined':
      return { action: 'declined', errorId: 'write-declined' };
    case 'failed':
      return fail('write-failed');
  }
}

function applyProjectSkill(
  project: ProjectWriterSurface,
  editor: McpWiringEditorId,
  projectDir: string,
  desired: PlannedStep['desired'],
  logger: AgentIntegrationsLogger,
): ExecutedOutcome {
  if (desired === 'absent') {
    const removed = project.removeProjectSkill(editor, projectDir);
    switch (removed.action) {
      case 'removed':
        return { action: 'removed' };
      case 'not-present':
        return { action: 'no-op' };
      case 'skipped-unsupported':
        return missing();
      case 'failed':
        logWriteFailure(logger, editor, removed.error);
        return fail('write-failed');
    }
  }

  const written = project.writeProjectSkill(editor, projectDir);
  switch (written.action) {
    case 'written':
    case 'overwritten':
      return { action: written.action };
    case 'skipped-unsupported':
      return missing();
    case 'skipped-prerequisite':
      return { action: 'skipped-prerequisite', errorId: 'dependency-failed' };
    case 'failed':
      logWriteFailure(logger, editor, written.error);
      return fail('write-failed');
  }
}

function applyUserSkill(
  global: GlobalWriterSurface,
  editor: McpWiringEditorId,
  desired: PlannedStep['desired'],
  logger: AgentIntegrationsLogger,
): ExecutedOutcome {
  if (desired === 'absent') {
    const removed = global.removeUserSkill(editor);
    switch (removed.action) {
      case 'removed':
        return { action: 'removed' };
      case 'not-present':
        return { action: 'no-op' };
      case 'skipped-unsupported':
        return missing();
      case 'failed':
        logWriteFailure(logger, editor, removed.error);
        return fail('write-failed');
    }
  }
  const written = global.writeUserSkill(editor);
  switch (written.action) {
    case 'written':
    case 'overwritten':
      return { action: written.action };
    case 'skipped-unsupported':
      return missing();
    case 'failed':
      logWriteFailure(logger, editor, written.error);
      return fail('write-failed');
  }
}

interface DesktopStepExecutorOptions {
  readonly surfaces: AgentRegistryWriterSurfaces;
  readonly projectDir: string | null;
  readonly logger: AgentIntegrationsLogger;
}

function createDesktopStepExecutor(options: DesktopStepExecutorOptions): StepExecutor {
  const { surfaces, projectDir } = options;

  return (step) => {
    const editor = locationEditor(step);
    if (editor === null) return { action: 'skipped-unsupported', errorId: 'no-writer' };

    if (step.scope === 'user') {
      return step.piece === 'mcp'
        ? applyUserMcp(surfaces.global, editor, step.desired)
        : applyUserSkill(surfaces.global, editor, step.desired, options.logger);
    }
    if (step.scope !== 'project') return { action: 'skipped-unsupported', errorId: 'no-writer' };
    if (projectDir === null) return missing();

    return step.piece === 'mcp'
      ? applyProjectMcp(surfaces.project, editor, projectDir, step.desired)
      : applyProjectSkill(surfaces.project, editor, projectDir, step.desired, options.logger);
  };
}

function userSkillOutcome(actions: readonly AppliedStep[]): 'installed' | 'removed' | null {
  const steps = actions.filter((action) => action.piece === 'skill' && action.scope === 'user');
  if (steps.some((s) => s.action === 'written' || s.action === 'overwritten')) return 'installed';
  if (steps.some((s) => s.action === 'removed')) return 'removed';
  return null;
}

export interface ApplyIntentsOptions {
  readonly surfaces: AgentRegistryWriterSurfaces;
  readonly projectDir: string | null;
  readonly logger?: AgentIntegrationsLogger;
  readonly snapshot: () => Promise<HostSnapshot>;
}

export async function applyIntents(
  request: AgentIntegrationsApplyRequest | null | undefined,
  options: ApplyIntentsOptions,
): Promise<{ report: ApplyReport; snapshot: HostSnapshot }> {
  const before = await options.snapshot();
  const view = buildConnectionsView({ probes: before.probes, detection: before.detection });

  const intents = (Array.isArray(request?.intents) ? request.intents : []).map((intent) => ({
    satisfierId: intent?.satisfierId as SatisfierId,
    desired: intent?.desired,
  }));

  const report = await executePlan(
    planIntents(intents, view),
    createDesktopStepExecutor({
      surfaces: options.surfaces,
      projectDir: options.projectDir,
      logger: options.logger ?? DEFAULT_LOGGER,
    }),
  );

  const userSkill = userSkillOutcome(report.actions);
  if (userSkill === 'installed') {
    options.surfaces.global.recordUserSkillDecision?.(true);
  } else if (userSkill === 'removed' && !options.surfaces.global.userSkillPresentAnywhere()) {
    options.surfaces.global.recordUserSkillDecision?.(false);
  }

  return { report, snapshot: await options.snapshot() };
}

interface AgentIntegrationsLogger {
  warn(msg: string, ctx?: object): void;
}

const DEFAULT_LOGGER: AgentIntegrationsLogger = {
  warn: (msg, ctx) => console.warn('[agent-integrations-apply]', msg, ctx ?? ''),
};

export interface AgentIntegrationsApplyDelegateOpts {
  available: boolean;
  surfaces: AgentRegistryWriterSurfaces;
  resolveProjectDir(event: IpcMainInvokeEvent): string | null;
  snapshot(projectDir: string | null): Promise<HostSnapshot>;
  logger?: AgentIntegrationsLogger;
}

export type AgentIntegrationsApplyDelegate = (
  event: IpcMainInvokeEvent,
  request: AgentIntegrationsApplyRequest,
) => Promise<AgentIntegrationsApplyResult>;

const EMPTY_REPORT: ApplyReport = { actions: [], conflicts: [], withheld: [] };
const EMPTY_SNAPSHOT: HostSnapshot = {
  probes: EMPTY_PROBE_SNAPSHOT,
  detection: EMPTY_DETECTION_SNAPSHOT,
};

export function createAgentIntegrationsApplyDelegate(
  opts: AgentIntegrationsApplyDelegateOpts,
): AgentIntegrationsApplyDelegate {
  const { available, surfaces, resolveProjectDir, logger = DEFAULT_LOGGER } = opts;

  async function safeSnapshot(projectDir: string | null): Promise<HostSnapshot> {
    try {
      return await opts.snapshot(projectDir);
    } catch (err) {
      logger.warn('host snapshot failed', { err });
      return EMPTY_SNAPSHOT;
    }
  }

  async function run(
    event: IpcMainInvokeEvent,
    request: AgentIntegrationsApplyRequest,
  ): Promise<AgentIntegrationsApplyResult> {
    let projectDir: string | null;
    try {
      projectDir = resolveProjectDir(event);
    } catch (err) {
      logger.warn('resolveProjectDir threw', { err });
      projectDir = null;
    }

    if (!available) {
      const snapshot = await safeSnapshot(projectDir);
      logIpcError({
        event: 'ipc.error',
        channel: CHANNEL,
        reason: 'apply-unavailable',
        handler: 'agentIntegrationsApply',
      });
      return {
        ok: false,
        error: 'Managing AI tool connections is unavailable in this build.',
        unavailable: true,
        report: EMPTY_REPORT,
        snapshot,
      };
    }

    const { report, snapshot } = await applyIntents(request, {
      surfaces,
      projectDir,
      snapshot: () => safeSnapshot(projectDir),
      logger,
    });

    const failed = report.actions.filter((action) => action.errorId !== undefined);
    if (failed.length > 0 || report.conflicts.length > 0) {
      logIpcError({
        event: 'ipc.error',
        channel: CHANNEL,
        reason: 'apply-partial',
        handler: 'agentIntegrationsApply',
        cause: {
          failed: failed.map((action) => `${action.satisfierId}:${action.errorId}`),
          conflicts: report.conflicts.map((conflict) => conflict.kind),
        },
      });
      return {
        ok: false,
        error: 'Some AI tool connections could not be changed.',
        report,
        snapshot,
      };
    }

    return { ok: true, report, snapshot };
  }

  return async (event, request) => {
    try {
      return await run(event, request);
    } catch (err) {
      logIpcError({
        event: 'ipc.error',
        channel: CHANNEL,
        reason: 'apply-threw',
        handler: 'agentIntegrationsApply',
        cause: err,
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        report: EMPTY_REPORT,
        snapshot: EMPTY_SNAPSHOT,
      };
    }
  };
}
