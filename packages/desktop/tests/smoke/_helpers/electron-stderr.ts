/**
 * Electron main-process stdio capture for Playwright smoke tests.
 *
 * Playwright's `_electron.launch` returns an `ElectronApplication` with a
 * `.process()` accessor exposing the underlying Node `ChildProcess`. The
 * child's `stdout` and `stderr` reach the test runner's reporter, but no
 * outcome puts them in a CI artifact on their own, and on a timeout the
 * worker is killed mid-stream and the buffer is lost outright. The
 * structured warns (`show-gate-timeout`, `whenReady-unhandled-rejection`,
 * `navigator-load-failed`, `theme-applied-no-window-for-sender`) are
 * therefore invisible at exactly the moment they would diagnose a hang.
 *
 * This helper subscribes to both streams BEFORE the test body runs and
 * keeps a per-test buffer. On test exit the buffer is written to a file
 * under the test's output directory and attached to Playwright's
 * `testInfo` by PATH. Fixture teardown owns the call, so it fires even
 * when a per-test timeout cancels the test body.
 *
 * WARN — attach by `path`, never by `body`. The carrier rationale lives
 * here; the sites that depend on it point at this block instead of
 * restating it. Measured against Playwright 1.59.1; re-verify on any
 * upgrade, not just a major — the range admits minors, and these are
 * behaviors of public APIs that the docs do not specify.
 *
 * A `body` attachment never touches disk — Playwright keeps the buffer
 * inline instead of writing it — so nothing lands under the test's output
 * directory. The HTML reporter then inlines a `text/` content type into
 * the compressed report payload embedded in `index.html` rather than
 * writing a file under `playwright-report/data/`; a non-text body does get
 * a `data/` file, so it is specifically the text case that leaves no file
 * behind. CI uploads exactly two trees — the test output directory and the
 * HTML report directory — so a text body is a FILE in neither. The bytes
 * do ship, embedded in that payload, but only a browser opening the report
 * (or a hand-decode of the embedded zip) reaches them, and nothing greps
 * them. The terminal reporter is no fallback: it prints an inlined text
 * body truncated to its first 300 characters, against a main-process
 * buffer measured at 26,383. A `path` attachment is copied into
 * `<outputDir>/attachments/` and hash-copied into
 * `playwright-report/data/`, so the bytes survive in both trees as files,
 * greppable and untruncated.
 *
 * The one Playwright behavior the write leans on: `testInfo.outputPath()`
 * creates the output directory as a side effect — same 1.59.1 measurement,
 * same re-verify-on-any-upgrade.
 * If it stops holding, the write throws `ENOENT`. The failure is
 * surfaced rather than silent (the walk warns, and the CI control notices
 * an absent artifact on a failing run), but the bytes are gone.
 *
 * No production code dependency. Test infrastructure only.
 */

import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';

/**
 * The slice of `TestInfo` an attach needs. Narrowed rather than taken
 * whole so a test double is a real value the compiler checks against
 * Playwright's own signatures, not a cast past them.
 */
export type StderrAttachTarget = Pick<TestInfo, 'outputPath' | 'attach'>;

/** The slice of the launched app a capture needs, narrowed the same way. */
export interface StderrCaptureSource {
  process(): Pick<ChildProcess, 'stdout' | 'stderr'>;
}

/**
 * Artifact name for a registered app, shared by the file on disk
 * (`<name>.txt`), the attachment name, and any message that has to tell a
 * reader which file to go looking for. One rule, one place, so a warn can
 * never name a file that was never written.
 */
function stderrArtifactName(slot: number): string {
  return slot === 0 ? 'main-process-stderr' : `main-process-stderr-${slot + 1}`;
}

export interface ElectronStderrCapture {
  /**
   * Write the current buffer to a file under the test's output directory
   * and attach THAT FILE — see the WARN in the file header for why the
   * carrier is load-bearing. Safe to call on test timeout.
   *
   * `slot` is the app's zero-based registration index; it is required, and
   * `attachCapturedStderr`'s JSDoc explains why callers should let that
   * function supply it rather than passing one here.
   */
  attachTo(testInfo: StderrAttachTarget, slot: number): Promise<void>;
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
 * that point and dutifully buffers them. If the fixture then attaches the
 * capture to the failed-attempt's `testInfo`, Playwright's reporter
 * surfaces the attempt's `main-process-stderr` artifact in the run
 * output — and the reporter then counts the failed-attempt block as an
 * "error not part of any test", exiting the job with status 1 even when
 * `failOnFlakyTests: false` and the retry passes.
 *
 * That chain turns on WHETHER an attempt carries an attachment, not on
 * what the attachment carries, so this gate is independent of the carrier
 * rule in the file header. Worth stating because the chain was observed
 * against a body attachment and has not been re-measured since.
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
 * Attach every capture registered by one test, deriving each capture's
 * slot from its registration order. This, not `attachTo`, is what a
 * fixture calls.
 *
 * Two invariants live here, and other sites point at this block rather
 * than restating them.
 *
 * SLOTS. The slot is the whole defense against a second launch
 * overwriting the first, and passing it per call put a droppable argument
 * at the one site that must never drop it — `0` is a legitimate slot, so
 * an omission is indistinguishable from a deliberate first one except by
 * the call's arity. Deriving the slots here removes the argument from the
 * call site, so the wrong call cannot be written.
 *
 * FAILURE CONTAINMENT. A failure is reported and stepped over rather than
 * thrown, and the walk continues to the next capture. Callers run their
 * process-reap and directory-cleanup contracts after this returns, and
 * those only run if control reaches them. Losing one test's diagnostics is
 * recoverable; leaking an Electron process group into the worker-teardown
 * deadline is not.
 */
export async function attachCapturedStderr(
  testInfo: StderrAttachTarget,
  captures: readonly ElectronStderrCapture[],
): Promise<void> {
  for (const [slot, capture] of captures.entries()) {
    try {
      await capture.attachTo(testInfo, slot);
    } catch (error) {
      // Name the artifact, not the slot: a zero-based index sends a reader
      // looking for the wrong filename. The write runs before the attach,
      // so the two failure modes leave different evidence and the message
      // must not send a reader hunting a file that was never created.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[electron-stderr] could not attach ${stderrArtifactName(slot)}.txt: ${reason}. ` +
          'An attach-only failure leaves the bytes under the output directory; ' +
          'a write failure leaves nothing there.',
      );
    }
  }
}

/**
 * Subscribe to the Electron app's stdout + stderr immediately. Must be
 * called BEFORE the test body's first await on app behavior; the
 * warns fire during whenReady's microtasks which complete
 * within milliseconds of `launchApp` resolving.
 *
 * The subscription is fire-and-forget. Node's stream `data` events queue
 * into an array in this process; Playwright's worker exits do not
 * disturb the host process's buffer. Writing that buffer to a file and
 * attaching the FILE at test end — not the `attach()` call by itself — is
 * what surfaces it as a CI artifact; see the WARN in the file header.
 */
export function captureElectronStderr(app: StderrCaptureSource): ElectronStderrCapture {
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
    async attachTo(testInfo, slot) {
      // An empty buffer still produces the file so the artifact's presence
      // / absence at the path is itself a signal — "instrumentation ran"
      // vs "instrumentation crashed pre-launch" are distinguishable.
      const text = buffer.join('') || '(no stdout/stderr captured)';
      const name = stderrArtifactName(slot);
      // `outputPath` creates the test's output directory as a side effect,
      // so the write below needs no separate mkdir. Routing through it is
      // load-bearing, not stylistic: a readable path anywhere else is in
      // neither uploaded tree.
      const file = testInfo.outputPath(`${name}.txt`);
      writeFileSync(file, text, 'utf8');
      // The attachment name carries the slot too. Playwright renames a
      // path attachment to a content hash inside `playwright-report/data/`,
      // so in the tree uploaded unconditionally the name is all that says
      // which launch produced which buffer.
      await testInfo.attach(name, { path: file, contentType: 'text/plain' });
    },
  };
}
