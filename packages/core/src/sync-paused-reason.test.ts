import { describe, expect, test } from 'vitest';
import { SyncStatusSchema } from './schemas/api/sync-seed.ts';
import { SYNC_PAUSED_REASONS } from './sync-paused-reason.ts';

const baseStatus = {
  state: 'idle',
  lastSyncUtc: null,
  lastFetchUtc: null,
  lastPushedSha: null,
  ahead: 0,
  behind: 0,
  consecutiveFailures: 0,
  consecutivePushFailures: 0,
  conflictCount: 0,
  hasRemote: true,
  syncEnabled: true,
  identityUnresolved: false,
};

describe('SYNC_PAUSED_REASONS', () => {
  test('is a de-duplicated list of kebab-case tokens', () => {
    expect(SYNC_PAUSED_REASONS.length).toBe(new Set(SYNC_PAUSED_REASONS).size);
    for (const reason of SYNC_PAUSED_REASONS) {
      expect(reason, reason).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  test('every member is accepted by the wire schema it describes', () => {
    for (const reason of SYNC_PAUSED_REASONS) {
      expect(
        SyncStatusSchema.safeParse({ ...baseStatus, pausedReason: reason }).success,
        reason,
      ).toBe(true);
    }
  });

  test('the wire field stays open, so a newer server can name a reason this build lacks', () => {
    const parsed = SyncStatusSchema.safeParse({
      ...baseStatus,
      pausedReason: 'a-reason-from-the-future',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.pausedReason).toBe('a-reason-from-the-future');
  });
});
