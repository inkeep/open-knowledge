/**
 * Startup sweep that rewrites stale OK-managed MCP host config entries
 * forward to today's resilient chain shape.
 */
import { homedir } from 'node:os';
import {
  ALL_EDITOR_IDS,
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  isEntryUpToDate,
} from './editors.ts';
import { readExistingMcpEntry, writeEditorMcpConfig } from './init.ts';
import { buildMcpConfigMigrateEvent } from './mcp-migrate-event.ts';

export interface RepairOutcome {
  scope: 'user' | 'project';
  editorId: EditorId;
  configPath: string;
  outcome: 'no-entry' | 'canonical' | 'repaired' | 'write-failed' | 'declined';
  error?: string;
}

export interface RepairResult {
  outcomes: RepairOutcome[];
  repairedCount: number;
}

export interface RepairLogEvent {
  event: string;
  /** Present on every per-file event; absent on the sweep-level skip event. */
  scope?: 'user' | 'project';
  /** Present on `mcp-config-migrate` (always). Free-form identifier of the
   *  emitting code path; see `mcp-migrate-event.ts`. */
  surface?: string;
  /** Present on every per-file event; absent on the sweep-level skip event. */
  editorId?: EditorId | string;
  /** Present on every per-file event; absent on the sweep-level skip event. */
  configPath?: string;
  error?: string;
  /** Populated exclusively by `buildMcpConfigMigrateEvent`; the interface
   *  declares them so the structured event satisfies this shape. */
  priorCommand?: string | null;
  priorArgs?: unknown[] | null;
  reason?: string;
}

export interface RepairContext {
  /** Absolute path to the project root. Required — project-scope sweeps key off this. */
  projectDir: string;
  /** Override `os.homedir()` for tests. */
  home?: string;
  /** Sink for structured per-file events. Default: stderr JSON-lines. */
  logger?: (event: RepairLogEvent) => void;
  /**
   * Value of `process.env.OK_RECLAIM_DISABLE` — '1' short-circuits the sweep
   * with a structured `mcp-config-repair-skipped` event. Mirrors the env gate
   * in the desktop reclaim sweeps and the new CLI `repairSkills` sweep.
   */
  reclaimDisableEnv?: string | null;
}

/**
 * Sweep user-level and project-level MCP host configs and rewrite any
 * legacy bare-npx OK-managed entries forward to today's canonical shape.
 *
 * Iterates `ALL_EDITOR_IDS` for stable ordering. Per-file IO failures are
 * captured as `{outcome: 'write-failed', error}` outcomes and a structured
 * event is emitted via the injected logger — neither propagates. The
 * default logger (`process.stderr.write`) does not throw; a caller that
 * injects a logger which CAN throw should defend at the call site.
 * `bootStartServer` does this with an outer try/catch around the whole
 * sweep so even an exceptional logger can't break server start.
 */
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

// Some `target.configPath` implementations throw on platforms that don't
// support that editor (e.g. Claude Desktop on Linux). That's not an error
// in repair context — just nothing to sweep there.
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

  // `readExistingMcpEntry` is documented as never-throws (see `init.ts`): every
  // error path — unresolvable configPath, JSON/TOML parse failures, EACCES,
  // missing top-level key — surfaces as `null`. A try/catch here would be
  // unreachable code; defense-in-depth lives in the caller's outer try/catch
  // wrap (in `bootStartServer`).
  const existing = readExistingMcpEntry(opts.target, opts.cwd, opts.home, opts.configPathOverride);

  if (existing === null) {
    return { ...base, outcome: 'no-entry' };
  }

  if (isEntryUpToDate(existing)) return { ...base, outcome: 'canonical' };

  // Emit migrate event BEFORE the rewrite so field observability captures
  // every attempted migration — including writes that subsequently fail with
  // EACCES / EROFS. Counters that key off this event see "intent to migrate"
  // (most useful for tracking legacy-shape decay); the sibling
  // `mcp-config-repair-write-failed` event covers the failure tail.
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

  // The write path can decline a present config it won't safely edit. That is a
  // non-destructive leave-untouched, not a repair — report it as such.
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
