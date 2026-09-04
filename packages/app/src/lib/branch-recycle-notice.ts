export type ContentRecycleNotice =
  | { kind: 'branch-switch'; branch: string; at: number }
  | { kind: 'refused'; at: number };

export const BRANCH_SWITCH_NOTICE_MS = 6_000;

export const REFUSAL_WINDOW_MS = 60_000;

export function recordBranchMismatchDispatch(
  priorTimes: readonly number[],
  now: number,
): { times: number[]; escalate: boolean } {
  const times = priorTimes.filter((t) => now - t < REFUSAL_WINDOW_MS);
  times.push(now);
  return { times, escalate: times.length >= 2 };
}

export type RecycleBannerMode = 'hidden' | 'switch' | 'refused';

export function computeRecycleBannerMode(
  notice: ContentRecycleNotice | null | undefined,
  switchExpired: boolean,
): RecycleBannerMode {
  if (notice == null) return 'hidden';
  if (notice.kind === 'refused') return 'refused';
  return switchExpired ? 'hidden' : 'switch';
}
