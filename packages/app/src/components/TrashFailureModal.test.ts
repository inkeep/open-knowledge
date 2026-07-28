import { describe, expect, test } from 'vitest';

import {
  coerceTrashFailureReason,
  formatTrashFailureDetail,
  type TrashFailedTarget,
  TrashFailureModal,
} from './TrashFailureModal';

describe('TrashFailureModal exports', () => {
  test('exports the modal component and runtime helpers', () => {
    expect(typeof TrashFailureModal).toBe('function');
    expect(typeof formatTrashFailureDetail).toBe('function');
    expect(typeof coerceTrashFailureReason).toBe('function');
  });
});

describe('TrashFailureModal detail formatting', () => {
  test('formats reason and detail when OS detail is present', () => {
    const target: TrashFailedTarget = {
      kind: 'file',
      path: 'notes/foo.md',
      name: 'foo.md',
      reason: 'permission-denied',
      detail: 'Operation not permitted',
    };
    expect(formatTrashFailureDetail(target)).toBe(
      'Reason: Permission denied (Operation not permitted)',
    );
  });

  test('formats reason without detail when OS detail is absent', () => {
    const target: TrashFailedTarget = {
      kind: 'file',
      path: 'foo.md',
      name: 'foo.md',
      reason: 'not-found',
    };
    expect(formatTrashFailureDetail(target)).toBe('Reason: File not found');
  });

  test('maps every known trash failure reason to a non-empty user-facing label', () => {
    const reasons = ['not-found', 'permission-denied', 'system-error', 'path-escape'] as const;
    for (const reason of reasons) {
      const out = formatTrashFailureDetail({
        kind: 'file',
        path: 'x.md',
        name: 'x.md',
        reason,
      });
      expect(out.startsWith('Reason: ')).toBe(true);
      expect(out.length).toBeGreaterThan('Reason: '.length);
    }
  });
});

describe('TrashFailureModal IPC reason coercion', () => {
  test('passes through known IPC reasons and coerces unknown values to system-error', () => {
    expect(coerceTrashFailureReason('not-found')).toBe('not-found');
    expect(coerceTrashFailureReason('permission-denied')).toBe('permission-denied');
    expect(coerceTrashFailureReason('system-error')).toBe('system-error');
    expect(coerceTrashFailureReason('path-escape')).toBe('path-escape');
    expect(coerceTrashFailureReason('future-desktop-reason')).toBe('system-error');
    expect(coerceTrashFailureReason(null)).toBe('system-error');
  });
});
