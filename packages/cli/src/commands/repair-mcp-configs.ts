import { homedir } from 'node:os';
import { classifyMcpLauncherEntry } from '@inkeep/open-knowledge-core';
import {
  ALL_EDITOR_IDS,
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  isEntryUpToDate,
} from './editors.ts';
import { type McpDeclineReason, readExistingMcpEntry, writeEditorMcpConfig } from './init.ts';
import { buildMcpConfigMigrateEvent } from './mcp-migrate-event.ts';

export interface RepairOutcome {
  scope: 'user' | 'project';
  editorId: EditorId;
  configPath: string;
  outcome: 'no-entry' | 'canonical' | 'repaired' | 'write-failed' | 'declined';
  reason?: McpDeclineReason;
  error?: string;
}

export interface RepairResult {
  outcomes: RepairOutcome[];
  repairedCount: number;
}

export interface RepairLogEvent {
  event: string;
  scope?: 'user' | 'project';
  surface?: string;
  editorId?: EditorId | string;
  configPath?: string;
  error?: string;
  priorCommand?: string | null;
  priorArgs?: unknown[] | null;
  reason?: string;
}

export interface RepairContext {
  projectDir: string;
  home?: string;
  logger?: (event: RepairLogEvent) => void;
  reclaimDisableEnv?: string | null;
}

export function repairMcpConfigs(ctx: RepairContext): RepairResult {
  const logger = ctx.logger ?? defaultLogger;
  const home = ctx.home ?? homedir();
  const outcomes: RepairOutcome[] = [];

  if (ctx.reclaimDisableEnv === '1') {
    logger({ event: 'mcp-config-repair-skipped', reason: 'reclaim-disabled' });
    return { outcomes, repairedCount: 0 };
  }

  for (const editorId of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[editorId];

    const userConfigPath = safeResolvePath(() => target.configPath('', home));
    if (userConfigPath !== null) {
      outcomes.push(
        repairOne({
          scope: 'user',
          editorId,
          target,
          home,
          cwd: '',
          configPath: userConfigPath,
          configPathOverride: undefined,
          logger,
        }),
      );
    }

    if (target.projectConfigPath) {
      const projectPathFn = target.projectConfigPath;
      const projectConfigPath = safeResolvePath(() => projectPathFn(ctx.projectDir));
      if (projectConfigPath !== null) {
        outcomes.push(
          repairOne({
            scope: 'project',
            editorId,
            target,
            home: undefined,
            cwd: ctx.projectDir,
            configPath: projectConfigPath,
            configPathOverride: projectConfigPath,
            logger,
          }),
        );
      }
    }
  }

  const repairedCount = outcomes.filter((o) => o.outcome === 'repaired').length;
  return { outcomes, repairedCount };
}

function safeResolvePath(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

interface RepairOneOptions {
  scope: 'user' | 'project';
  editorId: EditorId;
  target: EditorMcpTarget;
  home: string | undefined;
  cwd: string;
  configPath: string;
  configPathOverride: string | undefined;
  logger: (event: RepairLogEvent) => void;
}

function repairOne(opts: RepairOneOptions): RepairOutcome {
  const base = {
    scope: opts.scope,
    editorId: opts.editorId,
    configPath: opts.configPath,
  } as const;

  const existing = readExistingMcpEntry(opts.target, opts.cwd, opts.home, opts.configPathOverride);

  if (existing === null) {
    return { ...base, outcome: 'no-entry' };
  }

  if (opts.editorId === 'pi') {
    if (isEntryUpToDate(existing)) return { ...base, outcome: 'canonical' };
  } else {
    const launcher = classifyMcpLauncherEntry(existing);
    if (launcher.kind === 'recognized' && launcher.disposition === 'keep') {
      return { ...base, outcome: 'canonical' };
    }
    if (launcher.kind === 'declined' && opts.scope === 'project') {
      opts.logger({
        event: 'mcp-config-repair-declined',
        scope: opts.scope,
        editorId: opts.editorId,
        configPath: opts.configPath,
        reason: launcher.reason,
      });
      return { ...base, outcome: 'declined', reason: launcher.reason };
    }
  }

  opts.logger(
    buildMcpConfigMigrateEvent({
      scope: opts.scope,
      surface: 'cli-repair',
      editorId: opts.editorId,
      configPath: opts.configPath,
      priorEntry: existing,
    }),
  );

  const result = writeEditorMcpConfig(
    opts.target,
    opts.cwd,
    { mode: 'published', skipAvailabilityCheck: true },
    opts.home,
    opts.configPathOverride,
  );

  if (result.action === 'failed') {
    const error = result.error ?? 'unknown write failure';
    opts.logger({
      event: 'mcp-config-repair-write-failed',
      scope: opts.scope,
      editorId: opts.editorId,
      configPath: opts.configPath,
      error,
    });
    return { ...base, outcome: 'write-failed', error };
  }

  if (result.action === 'declined') {
    opts.logger({
      event: 'mcp-config-repair-declined',
      scope: opts.scope,
      editorId: opts.editorId,
      configPath: opts.configPath,
      reason: result.declineReason,
    });
    return { ...base, outcome: 'declined' };
  }

  return { ...base, outcome: 'repaired' };
}

function defaultLogger(event: RepairLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
