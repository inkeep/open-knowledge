/**
 * `onAuthenticate` algorithm for `removalRedirectGuard` (registered in
 * `server-factory.ts`). Extracted from the registration site so the
 * cache-first chain walk, the rollback-tolerant terminal check, the
 * cycle protection, and the defensive try/catch fall-through are
 * unit-testable without spinning up a full Hocuspocus instance.
 *
 * Algorithm contract (cache-first, file-existence-as-disambiguator):
 *   1. System / config docs short-circuit at entry — synthetic docs must
 *      never be cached or redirected (STOP rule).
 *   2. Consult the cache for `documentName` FIRST. The cache is the
 *      authoritative signal that a rename or delete happened — the
 *      filesystem can still lag for the narrow residual cases. The spine
 *      completes the disk move AND populates the cache BEFORE
 *      `captureAndCloseDocuments`, so a forced-reconnect client re-auths
 *      against a cache that already reflects the rename and finds the
 *      destination file on disk. The cache stays the authority because a
 *      brand-new connection can still land during the `git mv` syscall
 *      window, and a failed-rename rollback restores disk but not the
 *      cache.
 *   3. `undefined` cache entry: the docName has no removal history. Use
 *      `existsSync` only here to admit legitimate first-write and
 *      legitimate-recreation paths; either way admit.
 *   4. `kind: 'deleted'`: file exists at the docName ⇒ legitimate
 *      recreation, drop the stale cache entry and admit. Else
 *      reject with `'doc-deleted'`.
 *   5. `kind: 'renamed'`: walk the chain. At each hop, consult the
 *      cache: when `cache.get(target)` returns `undefined`, that is
 *      the terminal — redirect to it regardless of whether the file
 *      exists on disk. `fileExistsForDocName` is only consulted
 *      mid-chain when a hop has `kind: 'deleted'` (recreation
 *      collision). The cache's claim is authoritative for
 *      `renamed` chains — the spine completes the disk move before
 *      the forced close, and the residual `git mv` syscall window plus
 *      failed-rename rollback are bounded-cost cases. Recreation-
 *      collision mid-chain is handled by `/api/create-page` and the
 *      watcher's `add` event invalidating the cache for the recreated
 *      docName, which the cache lookup honors.
 *   6. Rollback tolerance (no explicit detection): failed-rename rollback
 *      where `withManagedRenameRecovery` restores the disk but not the
 *      cache produces a stale redirect to a non-existent target — bounded
 *      UX cost. The client's next handshake against the target either
 *      admits (post-restore disk) or loads an empty doc that resyncs when
 *      the user reloads. The chain walk treats the cache as authoritative
 *      (Step 5); no separate rollback branch exists.
 *   7. Cycle protection via a `visited` Set bounds the walk against a
 *      pathological cache state (A → B → A with neither file on disk):
 *      detect the revisit, log a structured warn, admit. Avoids a
 *      stack-overflow class for any input.
 *   8. The full body is wrapped in try/catch — any unexpected error
 *      (cache shape mismatch, fs probe failure, etc.) logs a structured
 *      warn and ADMITS the connection. The downstream phantom-doc guard
 *      at `persistence.ts` catches the IDB-empty case; the cost of
 *      crashing every connection over an extension bug is much higher
 *      than letting one stale tab through.
 */

import { HocuspocusAuthRejection } from './auth-token-schema.ts';
import { isReservedForUserTree } from './cc1-broadcast.ts';
import {
  incrementAuthDocDeleted,
  incrementAuthRemovalGuardError,
  incrementAuthRenameRedirect,
  incrementRemovalRedirectChainCycle,
} from './metrics.ts';
import type { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { setActiveSpanAttributes } from './telemetry.ts';

/**
 * Dependency triple for `runRemovalRedirectGuard`. Exported so tests can
 * type their stubs structurally — the production caller in
 * `server-factory.ts` constructs the value inline.
 */
export interface RemovalRedirectGuardDeps {
  recentlyRemovedDocs: RecentlyRemovedDocs;
  /** Resolve `docName` to its on-disk filesystem path, or `null` for an unsafe name. */
  resolveFilePath: (docName: string) => string | null;
  /** `existsSync`-shaped probe (injected for tests). */
  fileExists: (filePath: string) => boolean;
}

function fileExistsForDocName(deps: RemovalRedirectGuardDeps, docName: string): boolean {
  const filePath = deps.resolveFilePath(docName);
  return filePath !== null && deps.fileExists(filePath);
}

export async function runRemovalRedirectGuard(
  documentName: string,
  deps: RemovalRedirectGuardDeps,
): Promise<void> {
  try {
    if (isReservedForUserTree(documentName)) return;

    const originEntry = deps.recentlyRemovedDocs.get(documentName);
    if (originEntry === undefined) {
      // No removal history — admit. Whether the file exists or not, this
      // is either a legitimate connection or a legitimate first-write.
      return;
    }

    if (originEntry.kind === 'deleted') {
      // Recreation collision: a file at the same name
      // after a delete must admit. Drop the stale cache entry so the
      // next attempt skips the lookup entirely.
      if (fileExistsForDocName(deps, documentName)) {
        deps.recentlyRemovedDocs.delete(documentName);
        return;
      }
      incrementAuthDocDeleted();
      setActiveSpanAttributes({ 'auth.reason': 'doc-deleted' });
      throw new HocuspocusAuthRejection(
        'doc-deleted',
        `removed-doc rejection for deleted ${documentName}`,
      );
    }

    // originEntry.kind === 'renamed' — walk the chain. The walk is
    // bounded by a visited Set to defuse pathological cycles. We TRUST
    // the cache's claim absolutely (`/api/create-page` and the watcher's
    // 'add' event invalidate stale entries — eager invalidation
    // is upstream, not a downstream check here); admitting on `existsSync`
    // race-conditions with the in-flight rename window where the cache
    // has `A → B` but the disk move hasn't propagated. Failed-rename
    // rollback (rare; `withManagedRenameRecovery` restores the disk but
    // not the cache) produces a stale redirect to a non-existent target
    // — bounded UX cost; the client's next handshake against the target
    // either admits (post-restore disk) or loads an empty doc that
    // resyncs when the user reloads.
    const visited = new Set<string>([documentName]);
    let target = originEntry.newDocName;
    while (true) {
      if (visited.has(target)) {
        incrementRemovalRedirectChainCycle();
        console.warn(
          JSON.stringify({
            event: 'removal-redirect-chain-cycle',
            documentName,
            target,
          }),
        );
        return;
      }
      visited.add(target);

      const nextEntry = deps.recentlyRemovedDocs.get(target);
      if (nextEntry === undefined) {
        // Terminal: the cache has no further hop. Redirect to `target`.
        incrementAuthRenameRedirect();
        setActiveSpanAttributes({ 'auth.reason': 'rename-redirect' });
        throw new HocuspocusAuthRejection(
          'rename-redirect',
          `removed-doc redirect for ${documentName} → ${target}`,
          target,
        );
      }

      if (nextEntry.kind === 'deleted') {
        // Chain dead-ends at a delete. The terminal doc is gone.
        // Recreation collision at the terminal admits when the file is
        // present — but mid-chain recreation at the FROM end of any
        // hop is handled by `/api/create-page` invalidating the cache
        // for that name, which the next `cache.get` reflects.
        if (fileExistsForDocName(deps, target)) {
          deps.recentlyRemovedDocs.delete(target);
          // The terminal was recreated; admit the originating connect to
          // its mid-chain ancestor only if the chain otherwise resolves.
          // Conservative choice: still redirect to the terminal so the
          // client lands on the live doc rather than the stale ancestor.
          incrementAuthRenameRedirect();
          setActiveSpanAttributes({ 'auth.reason': 'rename-redirect' });
          throw new HocuspocusAuthRejection(
            'rename-redirect',
            `removed-doc redirect for ${documentName} → ${target}`,
            target,
          );
        }
        incrementAuthDocDeleted();
        setActiveSpanAttributes({ 'auth.reason': 'doc-deleted' });
        throw new HocuspocusAuthRejection(
          'doc-deleted',
          `removed-doc rejection for deleted ${documentName}`,
        );
      }

      target = nextEntry.newDocName;
    }
  } catch (err) {
    if (err instanceof HocuspocusAuthRejection) throw err;
    incrementAuthRemovalGuardError();
    console.warn(
      JSON.stringify({
        event: 'removal-redirect-extension-error',
        documentName,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
