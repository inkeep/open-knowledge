import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  EDITOR_PROJECT_CONFIG_PATH,
  type EditorId,
  type ExecutedOutcome,
  type PlannedStep,
  parsePathId,
  type StepExecutor,
} from '@inkeep/open-knowledge-core';
import { getLogger } from '@inkeep/open-knowledge-server';
import { EDITOR_TARGETS, type McpInstallOptions } from '../commands/editors.ts';
import { writeEditorMcpConfig, writeUserMcpConfigs } from '../commands/init.ts';
import { removeOwnMcpEntry } from '../commands/mcp-config-removal.ts';
import { removeProjectSkill, writeProjectSkill } from './write-project-skill.ts';
import { removeUserSkill, writeUserSkill } from './write-user-skill.ts';

const INSTALL_OPTIONS: McpInstallOptions = {
  mode: 'published',
  skipAvailabilityCheck: true,
  replaceEntry: true,
};

export interface CliWriteContext {
  readonly cwd: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function fail(): ExecutedOutcome {
  return { action: 'failed', errorId: 'write-failed' };
}

function missing(): ExecutedOutcome {
  return { action: 'skipped-missing', errorId: 'surface-missing' };
}

function logWriteFailure(editor: EditorId, path: string, reason: string | undefined): void {
  getLogger('agent-integrations-apply').warn({ editor, path, reason }, 'skill write failed');
}

function unwritable(): ExecutedOutcome {
  return { action: 'skipped-unsupported', errorId: 'no-writer' };
}

function removalOutcome(kind: 'removed' | 'not-present' | 'left-foreign' | 'declined') {
  switch (kind) {
    case 'removed':
      return { action: 'removed' } as const;
    case 'not-present':
      return { action: 'no-op' } as const;
    case 'left-foreign':
      return { action: 'skipped-foreign', errorId: 'foreign-artifact' } as const;
    case 'declined':
      return { action: 'declined', errorId: 'write-declined' } as const;
  }
}

function removeMcp(
  editor: EditorId,
  cwd: string,
  home: string | undefined,
  configPath?: string,
  env?: NodeJS.ProcessEnv,
): ExecutedOutcome {
  const target = EDITOR_TARGETS[editor];
  try {
    const outcome = removeOwnMcpEntry(target, cwd, home, configPath, env);
    if (outcome.kind === 'removed' && outcome.trustDetail) {
      getLogger('agent-integrations-apply').warn(
        {
          editor,
          path: configPath ?? target.configPath(cwd, home),
          trust: outcome.trust,
          trustDetail: outcome.trustDetail,
        },
        'MCP config removal retained Pi folder trust',
      );
    }
    return removalOutcome(outcome.kind);
  } catch (error) {
    getLogger('agent-integrations-apply').warn(
      {
        editor,
        path: configPath ?? target.configPath(cwd, home),
        reason: error instanceof Error ? error.message : String(error),
      },
      'MCP config removal failed',
    );
    return fail();
  }
}

async function applyUserMcp(
  editor: EditorId,
  ctx: CliWriteContext,
  desired: PlannedStep['desired'],
): Promise<ExecutedOutcome> {
  if (EDITOR_TARGETS[editor].scope !== 'global') return missing();

  if (desired === 'absent') {
    return removeMcp(editor, '', ctx.home, undefined, ctx.env);
  }

  const results = await writeUserMcpConfigs({
    editors: [editor],
    home: ctx.home,
    replaceEntry: true,
  });
  const result = results.find((entry) => entry.editorId === editor);
  if (result === undefined) return fail();
  switch (result.action) {
    case 'written':
    case 'overwritten':
      return { action: result.action };
    case 'declined':
      return { action: 'declined', errorId: 'write-declined' };
    case 'skipped-missing':
      return missing();
    case 'skipped-flag':
      return unwritable();
    default:
      return fail();
  }
}

function applyProjectMcp(
  editor: EditorId,
  ctx: CliWriteContext,
  desired: PlannedStep['desired'],
): ExecutedOutcome {
  const relative = EDITOR_PROJECT_CONFIG_PATH[editor];
  if (relative === null) return missing();
  const projectPath = join(ctx.cwd, relative);

  if (desired === 'absent') {
    return removeMcp(editor, ctx.cwd, ctx.home, projectPath, ctx.env);
  }

  const result = writeEditorMcpConfig(
    EDITOR_TARGETS[editor],
    ctx.cwd,
    INSTALL_OPTIONS,
    undefined,
    projectPath,
  );
  switch (result.action) {
    case 'written':
    case 'overwritten':
      return { action: result.action };
    case 'declined':
      return { action: 'declined', errorId: 'write-declined' };
    default:
      return fail();
  }
}

function applyUserSkill(
  editor: EditorId,
  ctx: CliWriteContext,
  desired: PlannedStep['desired'],
): ExecutedOutcome {
  const home = ctx.home ?? homedir();
  if (desired === 'absent') {
    const removed = removeUserSkill(editor, home);
    switch (removed.action) {
      case 'removed':
        return { action: 'removed' };
      case 'not-present':
        return { action: 'no-op' };
      case 'skipped-unsupported':
        return missing();
      case 'failed':
        logWriteFailure(editor, removed.path, removed.error);
        return fail();
    }
  }
  const written = writeUserSkill(editor, home);
  switch (written.action) {
    case 'written':
      return { action: 'written' };
    case 'overwritten':
      return { action: 'overwritten' };
    case 'skipped-unsupported':
      return missing();
    case 'failed':
      logWriteFailure(editor, written.path, written.error);
      return fail();
  }
}

function applyProjectSkill(
  editor: EditorId,
  ctx: CliWriteContext,
  desired: PlannedStep['desired'],
): ExecutedOutcome {
  if (desired === 'absent') {
    const removed = removeProjectSkill(EDITOR_TARGETS[editor], ctx.cwd);
    switch (removed.action) {
      case 'removed':
        return { action: 'removed' };
      case 'not-present':
        return { action: 'no-op' };
      case 'skipped-unsupported':
        return missing();
      case 'failed':
        logWriteFailure(editor, removed.path, removed.error);
        return fail();
    }
  }

  const written = writeProjectSkill(EDITOR_TARGETS[editor], ctx.cwd);
  switch (written.action) {
    case 'written':
      return { action: 'written' };
    case 'overwritten':
      return { action: 'overwritten' };
    case 'skipped-unsupported':
      return missing();
    case 'skipped-prerequisite':
      return { action: 'skipped-prerequisite', errorId: 'dependency-failed' };
    case 'failed':
      logWriteFailure(editor, written.path, written.error);
      return fail();
  }
}

export function createCliStepExecutor(ctx: CliWriteContext): StepExecutor {
  return (step) => {
    if (step.pathId === undefined) return unwritable();
    const location = parsePathId(step.pathId);
    if (location === null || location.kind === 'central-skill-store') return unwritable();

    switch (location.kind) {
      case 'editor-user-config':
        return applyUserMcp(location.editor, ctx, step.desired);
      case 'editor-project-config':
        return applyProjectMcp(location.editor, ctx, step.desired);
      case 'editor-project-skill-root':
        return applyProjectSkill(location.editor, ctx, step.desired);
      case 'editor-user-skill-root':
        return applyUserSkill(location.editor, ctx, step.desired);
    }
  };
}
