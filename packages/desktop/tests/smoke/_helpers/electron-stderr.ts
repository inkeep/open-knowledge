/**
 * Electron main-process stdio capture for Playwright smoke tests.
 *
 * Playwright's `_electron.launch` returns an `ElectronApplication` with a
 * `.process()` accessor exposing the underlying Node `ChildProcess`. The
 * child's `stdout` and `stderr` are normally captured by Playwright into
 * the test runner's reporter, but they DO NOT appear in CI artifacts when
 * a test times out — the worker is killed mid-stream and the buffer is
 * lost. The structured warns
 * (`show-gate-timeout`, `whenReady-unhandled-rejection`,
 * `navigator-load-failed`, `theme-applied-no-window-for-sender`) are
 * therefore invisible at exactly the moment they would diagnose a hang.
 *
 * This helper subscribes to both streams BEFORE the test body runs and
 * keeps a per-test buffer. On test exit (success or failure), the buffer
 * is attached to Playwright's `testInfo` as a `text/plain` artifact —
 * downloadable from the workflow run, visible in the HTML report. The
 * try/finally pattern in the consumer ensures the attachment fires even
 * on test timeout.
 *
 * No production code dependency. Test infrastructure only.
 */

import type { ElectronApplication, TestInfo } from '@playwright/test';

export interface ElectronStderrCapture {
  /** Read the buffered output as a single string. */
  drain(): string;
  /**
   * Attach the current buffer to the running Playwright test as a
   * `text/plain` artifact named `main-process-stderr`. Safe to call on
   * test timeout — the wrapping try/finally in the test body owns the
   * call site.
   */
  attachTo(testInfo: TestInfo): Promise<void>;
}

/**
 * Decide whether the captured stderr buffer is worth attaching to the
 * Playwright test artifact set. Returns `true` only when (a) this is the
 * final attempt — retries exhausted — AND (b) the final attempt is
 * failing. In every other case (success first try, flake-passed on retry,
 * non-final timed-out attempt that may still retry-pass, skipped) the
 * predicate returns `false` and the consumer should skip the attach.
 *
 * Why this is gated rather than unconditional: macOS sends SIGTERM/SIGKILL
 * to the Electron Helper subprocess when a Playwright test attempt times
 * out. The helper emits XPC errors to stderr during shutdown. Our
 * `captureElectronStderr` listener is still attached to `proc.stderr` at
 * that point and dutifully buffers them. If the fixture then attaches
 * that buffer to the failed-attempt's `testInfo`, Playwright's reporter
 * surfaces the attempt's `main-process-stderr` artifact in the run
 * output — and the reporter then counts the failed-attempt block as an
 * "error not part of any test", exiting the job with status 1 even when
 * `failOnFlakyTests: false` and the retry passes.
 *
 * The predicate's contract: attach iff the buffer carries diagnostic
 * value that justifies the cost of surfacing it. A failed-attempt that
 * may still retry-pass has no diagnostic value (the next attempt's
 * outcome is what matters). A passed test has no diagnostic need. Only
 * a final-attempt failure is worth surfacing.
 */
export function shouldAttachStderr(
  testInfo: Pick<TestInfo, 'status' | 'retry' | 'project'>,
): boolean {
  const retries = testInfo.project.retries ?? 0;
  const isFinalAttempt = testInfo.retry >= retries;
  const isFailing =
    testInfo.status === 'failed' ||
    testInfo.status === 'timedOut' ||
    testInfo.status === 'interrupted';
  return isFinalAttempt && isFailing;
}

/**
 * Subscribe to the Electron app's stdout + stderr immediately. Must be
 * called BEFORE the test body's first await on app behavior; the
 * warns fire during whenReady's microtasks which complete
 * within milliseconds of `launchApp` resolving.
 *
 * The subscription is fire-and-forget. Node's stream `data` events queue
 * into an array in this process; Playwright's worker exits do not
 * disturb the host process's buffer. The attachment-as-text-plain at
 * test end is what surfaces the buffer as a CI artifact.
 */
export function captureElectronStderr(app: ElectronApplication): ElectronStderrCapture {
  const buffer: string[] = [];
  const proc = app.process();

  function onChunk(stream: 'stdout' | 'stderr') {
    return (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer.push(`[${stream}] ${text}`);
    };
  }

  proc.stdout?.on('data', onChunk('stdout'));
  proc.stderr?.on('data', onChunk('stderr'));

  return {
    drain() {
      return buffer.join('');
    },
    async attachTo(testInfo) {
      // Empty buffer is still attached so the artifact's presence /
      // absence at the path is itself a signal — "instrumentation ran"
      // vs "instrumentation crashed pre-launch" are distinguishable.
      await testInfo.attach('main-process-stderr', {
        body: buffer.join('') || '(no stdout/stderr captured)',
        contentType: 'text/plain',
      });
    },
  };
}
