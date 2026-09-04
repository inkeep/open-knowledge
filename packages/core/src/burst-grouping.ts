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

export function bucketIntoBursts(
  sessionTransactions: Array<SessionTransaction>,
  humanEdits: Array<HumanEdit>,
  agentTypeFilter?: string,
): Burst[] {
  if (sessionTransactions.length === 0) return [];

  const sortedHumanTs = [...humanEdits].map((e) => e.timestamp).sort((a, b) => a - b);

  function humanEditBetween(ts1: number, ts2: number): boolean {
    const lo = Math.min(ts1, ts2);
    const hi = Math.max(ts1, ts2);
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
