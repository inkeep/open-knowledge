import { expect, test } from 'vitest';
import {
  computeRecycleBannerMode,
  REFUSAL_WINDOW_MS,
  recordBranchMismatchDispatch,
} from './branch-recycle-notice';

test('one refusal dispatch stays silent — it IS the normal recovery path', () => {
  const { times, escalate } = recordBranchMismatchDispatch([], 1_000);
  expect(escalate).toBe(false);
  expect(times).toEqual([1_000]);
});

test('a second dispatch inside the window escalates — recovery did not converge', () => {
  const first = recordBranchMismatchDispatch([], 1_000);
  const second = recordBranchMismatchDispatch(first.times, 5_000);
  expect(second.escalate).toBe(true);
});

test('dispatches outside the window are pruned, not accumulated forever', () => {
  const first = recordBranchMismatchDispatch([], 1_000);
  const later = recordBranchMismatchDispatch(first.times, 1_000 + REFUSAL_WINDOW_MS + 1);
  expect(later.escalate).toBe(false);
  expect(later.times).toEqual([1_000 + REFUSAL_WINDOW_MS + 1]);
});

test('a branch-switch notice is visible until its expiry flag flips', () => {
  const notice = { kind: 'branch-switch', branch: 'main', at: 10_000 } as const;
  expect(computeRecycleBannerMode(notice, false)).toBe('switch');
  expect(computeRecycleBannerMode(notice, true)).toBe('hidden');
});

test('a refused notice never times out — only dismissal or a real switch clears it', () => {
  const notice = { kind: 'refused', at: 10_000 } as const;
  expect(computeRecycleBannerMode(notice, true)).toBe('refused');
  expect(computeRecycleBannerMode(null, false)).toBe('hidden');
});
