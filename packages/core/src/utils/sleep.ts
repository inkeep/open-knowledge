/**
 * Resolve after `ms` milliseconds. Uses the global `setTimeout` (not
 * `node:timers/promises`) so it stays importable from browser bundles —
 * this module is exported via the core main barrel, which must remain
 * browser-safe.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
