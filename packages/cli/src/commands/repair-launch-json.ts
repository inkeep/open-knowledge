/**
 * Startup sweep that REMOVES OK's own `.claude/launch.json` entry.
 *
 * OK no longer scaffolds a launch.json — Claude Code Desktop's in-app Browser
 * pane opens the preview URL directly. This sweep, run from `bootStartServer`
 * (CLI `ok start`) alongside `repairMcpConfigs`, surgically removes any
 * `open-knowledge-ui` entry a prior OK version left in a (possibly shared)
 * `.claude/launch.json`, preserving every other configuration. Fail-soft: IO
 * failures inside `removeOwnLaunchEntry` surface as its executor's `failed`
 * op; the reclaim gate short-circuits with a structured event.
 */
import { join } from 'node:path';
import { removeOwnLaunchEntry } from './launch-json-removal.ts';

export interface LaunchJsonRepairOutcome {
  configPath: string;
  /**
   * - `removed` / `removed-file` — OK's entry (or the whole OK-only file) was
   *   removed from a pre-existing `.claude/launch.json`.
   * - `not-present` — no file, or no OK entry; nothing to clean up.
   * - `declined` — file exists but is malformed; left untouched.
   * - `skipped-reclaim-disabled` — `OK_RECLAIM_DISABLE=1` short-circuited.
   */
  outcome:
    | 'removed'
    | 'removed-file'
    | 'not-present'
    | 'declined'
    | 'write-failed'
    | 'skipped-reclaim-disabled';
  error?: string;
}

export interface LaunchJsonRepairResult {
  outcome: LaunchJsonRepairOutcome;
  /** 1 when an entry (or the OK-only file) was removed, else 0. */
  repairedCount: 0 | 1;
}

export interface LaunchJsonRepairLogEvent {
  event: string;
  configPath?: string;
  reason?: string;
}

export interface LaunchJsonRepairContext {
  /** Absolute path to the project root. The sweep targets `<projectDir>/.claude/launch.json`. */
  projectDir: string;
  /** Sink for the structured event. Default: stderr JSON-lines. */
  logger?: (event: LaunchJsonRepairLogEvent) => void;
  /** `process.env.OK_RECLAIM_DISABLE` — '1' short-circuits with a skip event. */
  reclaimDisableEnv?: string | null;
}

/**
 * Remove OK's `open-knowledge-ui` entry from `<projectDir>/.claude/launch.json`
 * if present. Single-file sweep; no fan-out and no user-scope analogue.
 * Fail-soft — never throws.
 */
export function repairLaunchJson(ctx: LaunchJsonRepairContext): LaunchJsonRepairResult {
  const logger = ctx.logger ?? defaultLogger;
  const configPath = join(ctx.projectDir, '.claude', 'launch.json');

  if (ctx.reclaimDisableEnv === '1') {
    logger({ event: 'launch-json-repair-skipped', reason: 'reclaim-disabled' });
    return { outcome: { configPath, outcome: 'skipped-reclaim-disabled' }, repairedCount: 0 };
  }

  let result: ReturnType<typeof removeOwnLaunchEntry>;
  try {
    result = removeOwnLaunchEntry(ctx.projectDir);
  } catch (err) {
    // removeOwnLaunchEntry propagates a final write/unlink IO failure; keep the
    // startup sweep fail-soft so `ok start` never crashes on a read-only file.
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'launch-json-repair-write-failed', configPath });
    return { outcome: { configPath, outcome: 'write-failed', error }, repairedCount: 0 };
  }
  const removed = result.kind === 'removed' || result.kind === 'removed-file';
  if (removed) logger({ event: 'launch-json-repair-removed', configPath });
  return { outcome: { configPath, outcome: result.kind }, repairedCount: removed ? 1 : 0 };
}

function defaultLogger(event: LaunchJsonRepairLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
