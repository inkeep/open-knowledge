import type {
  HandoffFailureReason,
  HandoffScope,
  HandoffTarget,
} from '@inkeep/open-knowledge-core';

export type HandoffHost = 'electron' | 'web';

type HandoffOutcomeStatus = 'ok' | 'error';

export interface HandoffStatsLine {
  readonly target: HandoffTarget;
  readonly host: HandoffHost;
  readonly outcome: HandoffOutcomeStatus;
  readonly ts: string;
  readonly reason?: HandoffFailureReason;
  /** Set only on a selection-scoped dispatch; absent on file / folder /
   *  project handoffs. Mirrors `HandoffScope`. */
  readonly scope?: HandoffScope;
}

interface RecordHandoffDeps {
  readonly okDesktop?: { shell: { recordHandoff(line: HandoffStatsLine): Promise<void> } };
  readonly warn?: (message: string) => void;
}

export async function recordHandoff(
  line: HandoffStatsLine,
  deps: RecordHandoffDeps = {},
): Promise<void> {
  const okDesktop =
    deps.okDesktop ?? (typeof window !== 'undefined' ? window.okDesktop : undefined);
  if (!okDesktop?.shell?.recordHandoff) {
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
