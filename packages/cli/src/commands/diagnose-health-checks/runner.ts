import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

export const DEFAULT_CHECK_TIMEOUT_MS = 5000;

export interface RunCheckOptions {
  timeoutMs?: number;
}

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

    const checkPromise = def.run(ctx);
    const result = await Promise.race([checkPromise, timeoutPromise]);
    checkPromise.catch(() => {});
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
