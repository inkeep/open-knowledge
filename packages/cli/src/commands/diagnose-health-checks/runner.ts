/**
 * Runner for `ok diagnose health` checks.
 *
 * Wraps each check with a hard timeout (default 5000 ms) and a try/catch
 * boundary so check-internal crashes never propagate out as uncaught
 * exceptions. The runner never short-circuits — every selected check runs,
 * so the user sees the full report even when one check fails.
 */

import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

/** Per-check hard timeout. Bounds the worst case for a hung check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;

export interface RunCheckOptions {
  /** Override the default timeout (testing only). */
  timeoutMs?: number;
}

/**
 * Run a single check with timeout + crash protection. Returns a
 * `CheckResult` in every branch — no thrown errors escape.
 */
export async function runCheck(
  def: CheckDefinition,
  ctx: CheckContext,
  opts: RunCheckOptions = {},
): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutSeconds = Math.round(timeoutMs / 1000);

  try {
    const timeoutPromise = new Promise<CheckResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          name: def.name,
          status: 'fail',
          summary: `check timed out after ${timeoutSeconds}s`,
        });
      }, timeoutMs);
    });

    // Capture the check promise so we can suppress a late rejection if the
    // timeout wins the race. Without this, a check that times out AND then
    // rejects asynchronously (e.g. a subprocess that the check spawned
    // crashes after the timeout already fired) produces an unhandled
    // rejection — and Bun's default behavior on unhandled rejections is to
    // terminate the process, which would crash the runner after the results
    // were already printed.
    const checkPromise = def.run(ctx);
    const result = await Promise.race([checkPromise, timeoutPromise]);
    checkPromise.catch(() => {
      // Intentional: the timeout already resolved the race with a 'fail'
      // status. The check's eventual rejection is no longer actionable.
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: def.name,
      status: 'fail',
      summary: `check crashed: ${message}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run every definition in order; results preserve registration order. */
export async function runAllChecks(
  defs: readonly CheckDefinition[],
  ctx: CheckContext,
  opts: RunCheckOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const def of defs) {
    results.push(await runCheck(def, ctx, opts));
  }
  return results;
}
