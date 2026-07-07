/**
 * Burst-grouping utility.
 *
 * Groups a session's transactions into user-edit-bounded bursts. A burst is a
 * maximal contiguous sequence of a session's transactions such that no human
 * edit timestamp falls strictly between consecutive transactions in the burst.
 *
 * Shared across timeline, presence, and graph halos so burst semantics don't
 * diverge per-surface.
 */

export interface SessionTransaction {
  session_id: string;
  timestamp: number;
  effect: unknown;
  agent_type?: string;
}

export interface HumanEdit {
  timestamp: number;
}

export interface Burst {
  session_id: string;
  start_ts: number;
  end_ts: number;
  transactions: SessionTransaction[];
}

/**
 * Groups session transactions into user-edit-bounded bursts.
 *
 * @param sessionTransactions  All agent transactions to bucket, in timestamp order.
 * @param humanEdits           Human-edit events used as burst boundaries.
 * @param agentTypeFilter      When provided, only bursts from sessions with matching agent_type are returned.
 */
export function bucketIntoBursts(
  sessionTransactions: Array<SessionTransaction>,
  humanEdits: Array<HumanEdit>,
  agentTypeFilter?: string,
): Burst[] {
  if (sessionTransactions.length === 0) return [];

  // Sort human edits ascending by timestamp for binary-search boundary checks.
  const sortedHumanTs = [...humanEdits].map((e) => e.timestamp).sort((a, b) => a - b);

  // Returns true if any human edit falls strictly between ts1 and ts2 (exclusive).
  function humanEditBetween(ts1: number, ts2: number): boolean {
    const lo = Math.min(ts1, ts2);
    const hi = Math.max(ts1, ts2);
    // Binary search: find first human edit > lo.
    let left = 0;
    let right = sortedHumanTs.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (sortedHumanTs[mid] <= lo) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return left < sortedHumanTs.length && sortedHumanTs[left] < hi;
  }

  // Group by session_id, preserving arrival order within each session.
  const bySession = new Map<string, SessionTransaction[]>();
  for (const tx of sessionTransactions) {
    let list = bySession.get(tx.session_id);
    if (!list) {
      list = [];
      bySession.set(tx.session_id, list);
    }
    list.push(tx);
  }

  const bursts: Burst[] = [];

  for (const [sessionId, txs] of bySession) {
    // Sort within session by timestamp to get contiguous ordering.
    const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);

    let burstStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const isLast = i === sorted.length;
      const breakBurst = isLast || humanEditBetween(sorted[i - 1].timestamp, sorted[i].timestamp);

      if (breakBurst) {
        const slice = sorted.slice(burstStart, i);
        bursts.push({
          session_id: sessionId,
          start_ts: slice[0].timestamp,
          end_ts: slice[slice.length - 1].timestamp,
          transactions: slice,
        });
        burstStart = i;
      }
    }
  }

  if (agentTypeFilter !== undefined) {
    return bursts.filter((b) => b.transactions.some((tx) => tx.agent_type === agentTypeFilter));
  }

  return bursts;
}
