import { describe, expect, test } from 'bun:test';
import type { TestInfo } from '@playwright/test';
import { shouldAttachStderr } from '../smoke/_helpers/electron-stderr';

describe('smoke-test fixture: shouldAttachStderr predicate', () => {
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
      expect(shouldAttachStderr(ti('timedOut', 0, 2))).toBe(false);

      expect(shouldAttachStderr(ti('passed', 1, 2))).toBe(false);
    });

    test('genuine failure scenario — final attempt failure surfaces stderr for triage', () => {
      expect(shouldAttachStderr(ti('timedOut', 0, 2))).toBe(false); // skip non-final
      expect(shouldAttachStderr(ti('timedOut', 1, 2))).toBe(false); // skip non-final
      expect(shouldAttachStderr(ti('timedOut', 2, 2))).toBe(true); // attach on final
    });
  });
});
