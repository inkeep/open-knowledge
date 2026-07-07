/**
 * Local-only telemetry counter for Open-in-Agent dispatch. Append-only JSONL
 * to `~/.ok/stats.jsonl` via the Electron main process. Zero
 * phone-home.
 *
 * Electron host forwards to the `ok:shell:record-handoff` IPC. Web host is a
 * no-op — the web fallback path deliberately ships without a server-side
 * append endpoint that would only matter for a non-target use case.
 *
 * `recordHandoff` NEVER throws. IPC rejection, unwritable HOME, or missing
 * bridge all collapse to a logged warning + resolved void — the dispatch
 * path (toast, dropdown, retry) is decoupled from telemetry.
 */

import type {
  HandoffFailureReason,
  HandoffScope,
  HandoffTarget,
} from '@inkeep/open-knowledge-core';

/** Host the dispatch came from. Used to scope dogfood signal. */
export type HandoffHost = 'electron' | 'web';

/** Outcome status — `error` carries the optional `reason` discriminator. */
type HandoffOutcomeStatus = 'ok' | 'error';

/**
 * One JSONL line in `~/.ok/stats.jsonl`. Schema is intentionally
 * narrow to keep the signal comparable across versions.
 */
export interface HandoffStatsLine {
  readonly target: HandoffTarget;
  readonly host: HandoffHost;
  readonly outcome: HandoffOutcomeStatus;
  /** ISO 8601 — caller-supplied so unit tests can pin a deterministic value. */
  readonly ts: string;
  /** Present only on `outcome:'error'`. Mirrors `HandoffFailureReason`. */
  readonly reason?: HandoffFailureReason;
  /** Set only on a selection-scoped dispatch; absent on file / folder /
   *  project handoffs. Mirrors `HandoffScope`. */
  readonly scope?: HandoffScope;
}

/**
 * Renderer-side dependencies. The `okDesktop` slot is filled from
 * `window.okDesktop` by default; tests inject a fake to avoid touching the
 * real Electron preload.
 */
interface RecordHandoffDeps {
  readonly okDesktop?: { shell: { recordHandoff(line: HandoffStatsLine): Promise<void> } };
  /** Diagnostic sink — defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

/**
 * Append one telemetry line. Resolves to void on every code path:
 *   - Electron + IPC succeeds → resolves
 *   - Electron + IPC rejects → warn, resolves
 *   - Web host (no bridge)   → resolves immediately (no warn — expected path)
 */
export async function recordHandoff(
  line: HandoffStatsLine,
  deps: RecordHandoffDeps = {},
): Promise<void> {
  const okDesktop =
    deps.okDesktop ?? (typeof window !== 'undefined' ? window.okDesktop : undefined);
  if (!okDesktop?.shell?.recordHandoff) {
    // Web host — no-op without warning; every web dispatch would log noise.
    return;
  }
  try {
    await okDesktop.shell.recordHandoff(line);
  } catch (err) {
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[handoff] recordHandoff IPC rejected (telemetry skipped): ${reason}`);
  }
}
