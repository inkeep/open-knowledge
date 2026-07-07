/**
 * HocuspocusProvider sync + clock helpers.
 *
 * `window.__activeProvider` is the canonical editor-ready signal (DEV-gated
 * inside `DocumentContext.tsx`'s main useEffect). Tests poll it via
 * `waitForActiveProviderSynced` rather than sleeping for an arbitrary delay.
 *
 * `installClockAfterSync` is the opt-in primitive for deterministic advancement
 * of JS-event-loop timers (setTimeout/setInterval/rAF) in debounce-settled
 * tests. It is INCOMPATIBLE with any test that awaits real async:
 * - WebSocket messages
 * - CRDT propagation across peers
 * - Filesystem watchers
 * - Hocuspocus reconnect timers
 * - Network I/O
 *
 * do NOT install `page.clock` in `crdt-stress.e2e.ts`,
 * `fr-7a-disconnect-source-mode.e2e.ts`, or any test exercising provider
 * disconnect/reconnect.
 *
 * Mixed-timer protocol: for tests needing BOTH debounce advancement
 * and real-async, sequence as `install → advance → uninstall → await`. Never
 * `await page.waitForResponse` while the clock is installed.
 */

import type { Page } from '@playwright/test';

export interface WaitForProviderOptions {
  timeout?: number;
}

/**
 * Poll until `window.__activeProvider?.isSynced === true`.
 *
 * Replaces the common pattern `await page.waitForTimeout(300)` after opening
 * a document. The provider's synced flag is set by HocuspocusProvider when
 * the initial WebSocket handshake + Y.Doc state sync completes.
 */
export async function waitForActiveProviderSynced(
  page: Page,
  options: WaitForProviderOptions = {},
): Promise<void> {
  // Default timeout bumped from 15s → 60s because the prior `waitForFunction(fn,
  // { timeout: 15_000 })` hit the options-as-arg bug — the 15s
  // was silently dropped and the action fell back to the test-level 120s. That
  // 120s effective budget absorbed real-world provider sync variance (Vite
  // cold-start + WebSocket handshake + CRDT initial-sync under `workers=4`
  // parallel load). Fixing the signature exposed the reality: 15s is too
  // aggressive. 60s is half the test-level timeout — still surfaces a runaway
  // sync as a test failure, while matching the empirical upper bound observed
  // under full-suite CI contention. Callers that need stricter budgets pass
  // `{ timeout }` explicitly.
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: options.timeout ?? 60_000,
  });
}

/**
 * Wait for provider sync, then install Playwright's virtual clock so
 * `setTimeout`/`setInterval`/`requestAnimationFrame` become controllable via
 * `page.clock.runFor(ms)` / `page.clock.fastForward(ms)`.
 *
 * STOP: do NOT use in tests that await real WebSocket messages, CRDT
 * propagation, Hocuspocus reconnect, or filesystem watcher events. See the
 * module-level JSDoc for the full incompatibility list.
 *
 * Mixed-timer protocol: if the test also needs real-async waits,
 * sequence as `install → advance (page.clock.runFor) → uninstall → await`.
 */
export async function installClockAfterSync(page: Page): Promise<void> {
  await waitForActiveProviderSynced(page);
  await page.clock.install();
}
