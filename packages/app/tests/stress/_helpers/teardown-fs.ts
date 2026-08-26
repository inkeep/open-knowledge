/**
 * Filesystem-removal policy for e2e teardown — the `rmSync` sibling of
 * `tolerateDuringTeardown` in `server-process.ts`, written for the same
 * failure class one layer over.
 *
 * Every fixture here kills a dev server and then reclaims the directories it
 * was writing into. Both halves can fail for the same reason (the tree is not
 * quite gone yet), and both failures land in a `finally` that runs after the
 * last test has finished — so a throw is attributed to no test at all.
 * Playwright reports that as "N errors were not a part of any test": a fully
 * green report on a red run, and in the merge queue an ejection that rebuilds
 * everything queued behind it.
 *
 * `rmSync`'s `force` option is not the guard it looks like: it suppresses
 * ENOENT and nothing else, and `maxRetries` defaults to 0. A bare
 * `rmSync(dir, { recursive: true, force: true })` in a teardown therefore
 * throws on exactly the errnos a still-settling dev server produces, and — the
 * part that also leaks — the throw skips every sibling removal after it.
 *
 * This module answers both: retry what the kernel calls transient, tolerate
 * what means "someone else is holding this path", attempt every target
 * regardless, and rethrow anything else.
 */

import { rmSync } from 'node:fs';

/**
 * The removal errnos teardown reads as "the path is not ours to reclaim right
 * now". Anything else rethrows.
 *
 *   EBUSY     — a live handle or mount point. During teardown that is the Vite
 *               optimizer or a file-watcher that has not finished unwinding.
 *   ENOTEMPTY — a concurrent writer created entries inside a directory while
 *               the recursive walk was deleting it; same racing writer, seen
 *               from the other end.
 *   EPERM     — the platform's refusal-to-unlink code. On Windows it is what a
 *               locked file reports, so it is the same "held by something
 *               else" case rather than a distinct one.
 *
 * ENOENT is absent because `force` already suppresses it: it is the ordinary
 * outcome (nothing was left to remove) and warning on it would make every
 * teardown log.
 *
 * Deliberately NOT tolerated, because during teardown they are real news
 * rather than noise:
 *
 *   EMFILE / ENFILE — file-descriptor exhaustion. Node's own retry list
 *     includes these, so they are retried below, but a run that has exhausted
 *     its descriptors leaked them, and that is a defect this suite should
 *     report rather than absorb.
 *   ENOTDIR / EINVAL — a malformed path. A teardown pointed at the wrong
 *     variable must fail loudly; swallowing it would silently stop reclaiming
 *     anything.
 *   EACCES and everything else — no teardown story explains them on a tmpdir
 *     this process created.
 *
 * The tolerance is scoped to teardown, and the scoping is structural rather
 * than a convention someone has to remember: this function returns void, so no
 * caller can consume a "did the removal succeed?" answer, and there is nothing
 * for a swallowed failure to corrupt downstream. Removals whose success IS
 * consumed by the next statement — the per-test content reset in
 * `content-reset.ts`, the pre-rename clearing of the promotion target in
 * `global-warm-cache.ts` — keep a bare `rmSync` and keep throwing, because
 * there "the directory is still there" changes what happens next.
 *
 * A tolerated failure warns rather than passing silently. The residual risk is
 * a tmpdir that really is unreclaimable and accumulates across CI runs; this
 * line is the only trace such a leak would leave.
 */
const TOLERATED_REMOVAL_ERRNOS: ReadonlySet<string> = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

/**
 * Node retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM internally with a linear
 * backoff of `retryDelay` (100ms default) per attempt, but only when
 * `recursive` is set. Retrying first means a watcher that closes its handle a
 * moment later is actually reclaimed, so tolerance stays the last resort
 * rather than the first one. Three attempts bounds a stuck target at well
 * under a second — teardown budget, not a test's.
 */
const REMOVAL_RETRIES = 3;

/**
 * Remove every target, then report. Never lets a tolerated errno end the run,
 * never lets one failing target stop the others being reclaimed, and never
 * hides an errno that has no teardown explanation — the first such error is
 * rethrown once every target has been attempted.
 */
export function removeAllDuringTeardown(...targets: string[]): void {
  let firstUntolerated: unknown;
  for (const target of targets) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: REMOVAL_RETRIES });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined && TOLERATED_REMOVAL_ERRNOS.has(code)) {
        console.warn(`[e2e teardown] rm ${target} reported ${code}; leaving it behind`);
        continue;
      }
      firstUntolerated ??= err;
    }
  }
  if (firstUntolerated !== undefined) throw firstUntolerated;
}
