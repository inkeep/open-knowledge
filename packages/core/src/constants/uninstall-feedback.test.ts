import { describe, expect, test } from 'vitest';
import { UNINSTALL_FEEDBACK_REASONS as BARREL_REASONS } from '../index.ts';
import { isUninstallFeedbackReason, UNINSTALL_FEEDBACK_REASONS } from './uninstall-feedback.ts';

describe('uninstall feedback reasons taxonomy', () => {
  // Slugs travel to `/api/feedback` and are how churn tickets get grouped, so
  // editing or reordering one silently re-buckets every reason already filed
  // under it. Labels are display-only and free to reword.
  test('pins the slug set and order', () => {
    expect(UNINSTALL_FEEDBACK_REASONS.map((reason) => reason.value)).toEqual([
      'workflow-fit',
      'missing-feature',
      'hard-to-start',
      'unreliable',
      'switched-tool',
      'one-off',
      'other',
    ]);
  });

  test('every reason carries a distinct non-empty label', () => {
    const labels = UNINSTALL_FEEDBACK_REASONS.map((reason) => reason.label);
    for (const label of labels) {
      expect(label.trim()).not.toBe('');
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('is exported from the package barrel both surfaces import', () => {
    expect(BARREL_REASONS).toBe(UNINSTALL_FEEDBACK_REASONS);
  });

  test('admits exactly the taxonomy slugs and nothing else', () => {
    for (const reason of UNINSTALL_FEEDBACK_REASONS) {
      expect(isUninstallFeedbackReason(reason.value)).toBe(true);
    }
    for (const value of ['', 'other ', 'Other', 'too-expensive', undefined, null, 0, {}]) {
      expect(isUninstallFeedbackReason(value)).toBe(false);
    }
  });
});
