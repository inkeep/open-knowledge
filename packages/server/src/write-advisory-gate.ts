import type { Counter } from '@opentelemetry/api';
import { getLogger } from './logger.ts';
import { getMeter } from './telemetry.ts';

const log = getLogger('write-advisory');

type WriteAdvisoryKind = 'orphan-hints' | 'link-check' | 'lint-links';

type WriteAdvisoryDeferralReason = 'deadline' | 'busy';

export interface WriteAdvisoryGate {
  run<T>(advisory: WriteAdvisoryKind, work: () => Promise<T>, fallback: () => T): Promise<T>;
}

export const WRITE_ADVISORY_DEADLINE_MS = 1_500;

export const WRITE_ADVISORY_GATE_LOG_INTERVAL_MS = 60_000;

export const WRITE_ADVISORY_GATE_CLOSED_LOG =
  '[write-advisory] document index did not answer within the write-advisory deadline; skipping index-backed write advisories until it catches up';

export const WRITE_ADVISORY_GATE_REOPENED_LOG =
  '[write-advisory] document index caught up; index-backed write advisories resumed';

let _deferredCounter: Counter | null = null;
function deferredCounter(): Counter {
  _deferredCounter ||= getMeter().createCounter('ok.write_advisory.deferred', {
    description:
      'Post-write advisories that depend on the derived document index and were omitted from a write response: reason=deadline when the index did not answer within the write-advisory deadline, reason=busy when an earlier advisory was still waiting past its deadline so this one was not started. The write itself was durable either way.',
    unit: '{advisory}',
  });
  return _deferredCounter;
}

const DEADLINE_PASSED = Symbol('write-advisory-deadline');

export function createWriteAdvisoryGate(options: { deadlineMs?: number } = {}): WriteAdvisoryGate {
  const deadlineMs = options.deadlineMs ?? WRITE_ADVISORY_DEADLINE_MS;
  let overdue = 0;
  let closedSince = 0;
  let closingAdvisory: WriteAdvisoryKind | undefined;
  let closings = 0;
  let busySkipped = 0;
  let closedMs = 0;
  let lastLineAt: number | undefined;
  let pendingLine: ReturnType<typeof setTimeout> | undefined;

  const logGateState = (): void => {
    const now = Date.now();
    lastLineAt = now;
    const closed = overdue > 0;
    const counts = {
      closings,
      busySkipped,
      closedMs: closed ? closedMs + now - closedSince : closedMs,
    };
    closings = 0;
    busySkipped = 0;
    closedMs = 0;
    closedSince = now;
    if (closed) {
      log.warn(
        { advisory: closingAdvisory, deadlineMs, ...counts },
        WRITE_ADVISORY_GATE_CLOSED_LOG,
      );
    } else {
      log.info(counts, WRITE_ADVISORY_GATE_REOPENED_LOG);
    }
  };

  const noteGateChange = (): void => {
    if (pendingLine !== undefined) return;
    const now = Date.now();
    const nextLineAt =
      lastLineAt === undefined ? now : lastLineAt + WRITE_ADVISORY_GATE_LOG_INTERVAL_MS;
    if (now >= nextLineAt) {
      logGateState();
      return;
    }
    pendingLine = setTimeout(() => {
      pendingLine = undefined;
      logGateState();
    }, nextLineAt - now);
    pendingLine.unref();
  };

  const close = (advisory: WriteAdvisoryKind): void => {
    overdue += 1;
    if (overdue > 1) return;
    closedSince = Date.now();
    closingAdvisory = advisory;
    closings += 1;
    noteGateChange();
  };

  const release = (): void => {
    overdue -= 1;
    if (overdue > 0) return;
    closedMs += Date.now() - closedSince;
    noteGateChange();
  };

  const defer = <T>(
    advisory: WriteAdvisoryKind,
    reason: WriteAdvisoryDeferralReason,
    fallback: () => T,
  ): T => {
    deferredCounter().add(1, { advisory, reason });
    return fallback();
  };

  return {
    async run(advisory, work, fallback) {
      if (overdue > 0) {
        busySkipped += 1;
        return defer(advisory, 'busy', fallback);
      }
      let settledWork = false;
      let counted = false;
      const pending = Promise.resolve().then(work);
      const settle = (): void => {
        settledWork = true;
        if (counted) release();
      };
      void pending.then(settle, settle);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof DEADLINE_PASSED>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE_PASSED), deadlineMs);
      });
      try {
        const settled = await Promise.race([pending, deadline]);
        if (settled !== DEADLINE_PASSED) return settled;
        if (!settledWork) {
          counted = true;
          close(advisory);
        }
        void pending.catch((err: unknown) => {
          log.warn(
            { err, advisory },
            '[write-advisory] deferred advisory failed after its deadline',
          );
        });
        return defer(advisory, 'deadline', fallback);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
