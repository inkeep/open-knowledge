import type { TestInfo } from '@playwright/test';
import { describe, expect, test } from 'vitest';
import { shouldAttachStderr } from '../smoke/_helpers/electron-stderr';

/**
 * Pins the conditional-attach predicate that gates whether the smoke-test
 * `captureStderrFor` fixture surfaces its captured `main-process-stderr`
 * artifact on `testInfo`.
 *
 * `shouldAttachStderr`'s JSDoc in `_helpers/electron-stderr.ts` owns why
 * the predicate exists — the XPC-kill to reporter to exit-1 chain, the
 * final-attempt-only rule it produces, and the caveat about what that
 * chain has and has not been re-measured against.
 *
 * If you change the predicate's truth table, you are changing the contract
 * between the smoke fixture and Playwright's flake-tolerance gate.
 */
describe('smoke-test fixture: shouldAttachStderr predicate', () => {
  // Build a minimal TestInfo-shaped object; the predicate consumes only
  // `status`, `retry`, and `project.retries`. Cast through `unknown` keeps
  // the test independent of Playwright's full TestInfo shape (a hundred-
  // odd fields most of which are irrelevant here).
  const ti = (status: TestInfo['status'], retry: number, retries: number): TestInfo =>
    ({
      status,
      retry,
      project: { retries },
    }) as unknown as TestInfo;

  describe('CI-shaped projects (retries === 2)', () => {
    test('attempt 0 timed out, will retry → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('timedOut', 0, 2))).toBe(false);
    });

    test('attempt 1 timed out, will retry → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('timedOut', 1, 2))).toBe(false);
    });

    test('attempt 2 (final) timed out, retries exhausted → ATTACH', () => {
      expect(shouldAttachStderr(ti('timedOut', 2, 2))).toBe(true);
    });

    test('attempt 2 (final) failed, retries exhausted → ATTACH', () => {
      expect(shouldAttachStderr(ti('failed', 2, 2))).toBe(true);
    });

    test('attempt 2 (final) interrupted, retries exhausted → ATTACH', () => {
      expect(shouldAttachStderr(ti('interrupted', 2, 2))).toBe(true);
    });

    test('attempt 0 passed first try → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('passed', 0, 2))).toBe(false);
    });

    test('attempt 1 passed (flake-passed on first retry) → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('passed', 1, 2))).toBe(false);
    });

    test('attempt 2 passed (flake-passed on final retry) → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('passed', 2, 2))).toBe(false);
    });

    test('attempt 0 skipped → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('skipped', 0, 2))).toBe(false);
    });
  });

  describe('local-shaped projects (retries === 0, single attempt)', () => {
    test('single attempt failed → ATTACH (this IS the final attempt)', () => {
      expect(shouldAttachStderr(ti('failed', 0, 0))).toBe(true);
    });

    test('single attempt timed out → ATTACH', () => {
      expect(shouldAttachStderr(ti('timedOut', 0, 0))).toBe(true);
    });

    test('single attempt passed → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('passed', 0, 0))).toBe(false);
    });

    test('single attempt skipped → DO NOT attach', () => {
      expect(shouldAttachStderr(ti('skipped', 0, 0))).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('project.retries unset (treated as 0); failed first attempt → ATTACH', () => {
      const noRetries = {
        status: 'failed' as const,
        retry: 0,
        project: {},
      } as unknown as TestInfo;
      expect(shouldAttachStderr(noRetries)).toBe(true);
    });

    test('flake-passed scenario from CI run 25616440454 — exact reproduction', () => {
      // Test 1) consent-dialog.e2e.ts → attempt 0 timed out (60s),
      // attempt 1 passed. Attempt 0's testInfo has retry=0, retries=2,
      // status='timedOut'. The predicate MUST return false to suppress
      // the XPC-laden attachment that would otherwise surface as
      // "1 error not part of any test".
      expect(shouldAttachStderr(ti('timedOut', 0, 2))).toBe(false);

      // Attempt 1's testInfo has retry=1, retries=2, status='passed'.
      // The predicate MUST return false (success → no diagnostic value).
      expect(shouldAttachStderr(ti('passed', 1, 2))).toBe(false);

      // Combined: zero attachments across both attempts → zero "non-test
      // errors" → exit 0 → green job.
    });

    test('genuine failure scenario — final attempt failure surfaces stderr for triage', () => {
      // Hypothetical: timeout on attempt 0, timeout on attempt 1, timeout
      // on attempt 2 (final). Diagnostic value of attempt 2's stderr is
      // HIGH — this is a real failure, not a flake. The predicate MUST
      // return true on the final attempt so reviewers see the captured
      // helper output.
      expect(shouldAttachStderr(ti('timedOut', 0, 2))).toBe(false); // skip non-final
      expect(shouldAttachStderr(ti('timedOut', 1, 2))).toBe(false); // skip non-final
      expect(shouldAttachStderr(ti('timedOut', 2, 2))).toBe(true); // attach on final
    });
  });
});
