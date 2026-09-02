import { join } from 'node:path';
import { removeOwnLaunchEntry } from './launch-json-removal.ts';

export interface LaunchJsonRepairOutcome {
  configPath: string;
  outcome: 'removed' | 'not-present' | 'declined' | 'write-failed' | 'skipped-reclaim-disabled';
  error?: string;
}

export interface LaunchJsonRepairResult {
  outcome: LaunchJsonRepairOutcome;
  repairedCount: 0 | 1;
}

export interface LaunchJsonRepairLogEvent {
  event: string;
  configPath?: string;
  reason?: string;
}

export interface LaunchJsonRepairContext {
  projectDir: string;
  logger?: (event: LaunchJsonRepairLogEvent) => void;
  reclaimDisableEnv?: string | null;
}

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
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'launch-json-repair-write-failed', configPath });
    return { outcome: { configPath, outcome: 'write-failed', error }, repairedCount: 0 };
  }
  const removed = result.kind === 'removed';
  if (removed) logger({ event: 'launch-json-repair-removed', configPath });
  return { outcome: { configPath, outcome: result.kind }, repairedCount: removed ? 1 : 0 };
}

function defaultLogger(event: LaunchJsonRepairLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
