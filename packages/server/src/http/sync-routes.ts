/**
 * The sync family — `sync/status`, `sync/conflicts`, `sync/conflict-content`
 * (reads) plus `sync/trigger`, `sync/resolve-conflict`, `sync/resolve-blocking`
 * (mutating) — natively routed as one group. Handler bodies move byte-identically
 * from the legacy dispatch; what they closed over in the extension arrives as
 * {@link SyncRouteDeps}. Every endpoint reuses the shared loopback + origin
 * check from `local-op-security.ts` via the extension's `checkLocalOpSecurity`
 * shadow, lifted as a dep so the refusal travels with the handlers.
 *
 * The mutating trio keeps its legacy `MUTATING_ROUTES` membership, declared on
 * the table and pinned in the co-located table-tier test.
 */

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncResolveBlockingRequestSchema,
  SyncResolveBlockingSuccessSchema,
  SyncResolveConflictRequestSchema,
  SyncResolveConflictSuccessSchema,
  SyncStatusSchema,
  SyncTriggerRequestSchema,
  SyncTriggerSuccessSchema,
} from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import type { ResolveStrategy } from '../conflict-storage.ts';
import { isShareableOkArtifact } from '../content-filter.ts';
import { stripDocExtension } from '../doc-extensions.ts';
import type { PinoLogger } from '../logger.ts';
import { assertRealpathWithinDir } from '../symlink-guard.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { errnoCode } from './handler-utils.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

/**
 * Detects git merge-conflict marker triples at start-of-line. Requires
 * ALL THREE sentinels (`<<<<<<< `, `=======`, `>>>>>>> `) to co-occur —
 * git always writes the trio together, so single-sentinel matching would
 * false-positive on legitimate user content (e.g., a CommonMark setext H1
 * underline of exactly 7 `=` characters: `My Title\n=======`).
 *
 * Used by the `?source=ytext` branch of the conflict-content handler to
 * decide whether the live Y.Text snapshot is usable as `ours` (no marker
 * triple → safe to surface live edits) or polluted by the file watcher's
 * reopen-time disk seed (triple present → fall back to git-index `ours`).
 */
function ytextHasConflictMarkers(text: string): boolean {
  return /^<{7} /m.test(text) && /^={7}$/m.test(text) && /^>{7} /m.test(text);
}

export interface SyncRouteDeps {
  projectDir: string | undefined;
  hocuspocus: Hocuspocus;
  log: PinoLogger;
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  /** Live Y.Text snapshot for a loaded doc, or null when unavailable. */
  serializeDoc: ((docName: string) => string | null) | undefined;
}

export function createSyncRoutes(deps: SyncRouteDeps): ApiRouteGroup {
  const { projectDir, hocuspocus, log, checkLocalOpSecurity, getSyncEngine, serializeDoc } = deps;

  async function handleSyncStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-status' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-status',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const engine = getSyncEngine?.();
      if (!engine) {
        // Shape must stay aligned with SyncStatus (see sync-engine.ts) — the UI
        // reads these fields unconditionally. Dormant fallback when the engine
        // isn't constructed (no remote, sync disabled at boot).
        successResponse(
          res,
          200,
          SyncStatusSchema,
          {
            state: 'dormant',
            lastSyncUtc: null,
            lastFetchUtc: null,
            lastPushedSha: null,
            ahead: 0,
            behind: 0,
            consecutiveFailures: 0,
            conflictCount: 0,
            hasRemote: false,
            syncEnabled: false,
            identityUnresolved: false,
            remote: null,
          },
          { handler: 'sync-status' },
        );
        return;
      }
      // Lazy remote re-detection: if the user ran `git remote add origin <url>`
      // after the server booted, refresh `hasRemote` so the Settings → Sync
      // empty state and badge update without an app restart. No-op once a
      // remote has been observed.
      await engine.refreshRemote();
      successResponse(res, 200, SyncStatusSchema, engine.getStatus(), {
        handler: 'sync-status',
      });
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'sync-status',
        cause: e,
      });
    }
  }

  const handleSyncTrigger = withValidation(
    SyncTriggerRequestSchema,
    async (_req, res, body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        // Race-window guard: the preBodyGate confirmed the engine was active,
        // but it could have been torn down between gate and inner-handler
        // invocation. Treat as 503 — same as the gate would have.
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-trigger',
        });
        return;
      }
      const op = body.op ?? 'sync';
      // Fire-and-return: 202 Accepted immediately, trigger runs in background.
      successResponse(res, 202, SyncTriggerSuccessSchema, { op }, { handler: 'sync-trigger' });
      // `.catch` is mandatory on every fire-and-forget trigger: the response has
      // already been sent, so a rejection has nowhere to go but the process.
      void engine.trigger(op).catch((err) => {
        log.error({ err, op }, '[sync] fire-and-forget trigger failed');
      });
    },
    {
      handler: 'sync-trigger',
      method: 'POST',
      preBodyGate: (req, res) => {
        if (!checkLocalOpSecurity(req, res, { handler: 'sync-trigger' })) return false;
        const engine = getSyncEngine?.();
        if (!engine) {
          errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
            handler: 'sync-trigger',
          });
          return false;
        }
        return true;
      },
    },
  );

  /**
   * `POST /api/sync/resolve-blocking` — clear a pre-merge overlap pause by
   * committing the local edits that caused it, then resume.
   *
   * The body names an ACTION and nothing else. The paths come from the
   * engine's blocking set, so this cannot be aimed: a body-supplied path list
   * would make `discard` a general-purpose "throw away this file's edits"
   * endpoint reachable from any page the user's browser has open. Empty set →
   * 409 rather than a silent success, because a UI offering these buttons
   * against a pause that already cleared is showing the user stale state.
   *
   * The follow-up trigger is the point of the button: `commit` runs a full
   * sync, because the commit it just authored is now outgoing work.
   *
   * `commit` is the only action the schema admits. A `discard` verb is
   * deliberately withheld until a recoverable snapshot exists behind it —
   * restoring the blocking paths leaves no reflog entry to recover from.
   */
  const handleSyncResolveBlocking = withValidation(
    SyncResolveBlockingRequestSchema,
    // `body` is unread: the schema admits exactly one action, and the paths come
    // from engine state rather than the request (see the docblock above).
    async (_req, res, _body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-resolve-blocking',
        });
        return;
      }
      if (engine.getBlockingPaths().length === 0) {
        errorResponse(
          res,
          409,
          'urn:ok:error:no-blocking-changes',
          'No local changes are blocking a merge.',
          {
            handler: 'sync-resolve-blocking',
          },
        );
        return;
      }
      try {
        // `commit` is the only action. A `discard` verb was deliberately not
        // shipped: reverting uncommitted work is unrecoverable (git keeps no
        // reflog for it), and the destructive verb waits on a recoverable
        // snapshot landing first. The schema rejects anything else before this
        // point, so there is no second branch to fall through to.
        const paths = engine.getBlockingPaths();
        const commitSha = await engine.commitBlockingPaths();
        successResponse(
          res,
          200,
          SyncResolveBlockingSuccessSchema,
          { action: 'commit', paths, ...(commitSha !== null ? { commitSha } : {}) },
          { handler: 'sync-resolve-blocking' },
        );
        void engine.trigger('sync').catch((err) => {
          log.error({ err }, '[sync] resolve-blocking follow-up sync failed');
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'sync-resolve-blocking',
          cause: e,
        });
      }
    },
    {
      handler: 'sync-resolve-blocking',
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: 'sync-resolve-blocking' }),
    },
  );

  async function handleSyncConflicts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-conflicts' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-conflicts',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const engine = getSyncEngine?.();
      const conflicts = engine ? engine.getConflicts() : [];
      successResponse(
        res,
        200,
        SyncConflictsSuccessSchema,
        { conflicts },
        {
          handler: 'sync-conflicts',
        },
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'sync-conflicts',
        cause: e,
      });
    }
  }

  const handleSyncResolveConflict = withValidation(
    SyncResolveConflictRequestSchema,
    async (_req, res, body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        // Race-window guard — see HANDLE_SYNC_TRIGGER comment.
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-resolve-conflict',
        });
        return;
      }
      const { file, strategy, content } = body;
      try {
        await engine.resolveConflict(file, strategy as ResolveStrategy, content);
        successResponse(
          res,
          200,
          SyncResolveConflictSuccessSchema,
          {},
          {
            handler: 'sync-resolve-conflict',
          },
        );
      } catch (e) {
        // Surface the underlying error (typically the git commit stderr
        // wrapped by `ConflictStore.resolveConflict`) on the RFC 9457
        // `detail` field so operators + UI toasts + agent tools have the
        // diagnostic context — without this, every commit failure looks
        // identical at the client.
        const detail = e instanceof Error ? e.message : undefined;
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to resolve conflict.',
          {
            handler: 'sync-resolve-conflict',
            cause: e,
            detail,
          },
        );
      }
    },
    {
      handler: 'sync-resolve-conflict',
      method: 'POST',
      preBodyGate: (req, res) => {
        if (!checkLocalOpSecurity(req, res, { handler: 'sync-resolve-conflict' })) return false;
        const engine = getSyncEngine?.();
        if (!engine) {
          errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
            handler: 'sync-resolve-conflict',
          });
          return false;
        }
        return true;
      },
    },
  );

  async function handleSyncConflictContent(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-conflict-content' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-conflict-content',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    if (!projectDir) {
      errorResponse(
        res,
        503,
        'urn:ok:error:project-repo-not-configured',
        'Project repo not configured.',
        { handler: 'sync-conflict-content' },
      );
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const file = url.searchParams.get('file');
    if (!file) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Missing required query param: file.',
        {
          handler: 'sync-conflict-content',
        },
      );
      return;
    }
    // Reject obvious path-traversal; git itself rejects paths outside the index.
    if (file.includes('..') || file.startsWith('/')) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid file path.', {
        handler: 'sync-conflict-content',
      });
      return;
    }
    // Refuse the request when no conflict is tracked for the path. Without
    // this gate, the git stage reads silently return empty strings for
    // untracked files, producing a 200 response with empty base/ours/theirs
    // — misleading to agents that took the file path from a stale 409
    // envelope or have inconsistent state. The tool description on
    // `conflicts({ kind: 'content' })` documents this 404; the gate enforces it.
    //
    // Authority is split between two sources that normally agree but can
    // diverge in tests / external-git scenarios: (a) ConflictStore via the
    // SyncEngine — populated when SyncEngine merges; and (b) the doc's
    // `lifecycle.status` Y.Map — set by the file-watcher's `case 'conflict'`
    // branch even when SyncEngine wasn't involved (markers landed on disk
    // via external git ops). Accept EITHER as authoritative tracking.
    const trackedDocName = stripDocExtension(file);
    const loadedDoc = hocuspocus.documents.get(trackedDocName);
    const isConflictedByLifecycle = loadedDoc?.getMap('lifecycle').get('status') === 'conflict';
    const engine = getSyncEngine?.();
    const isTrackedByStore = engine ? engine.getConflicts().some((c) => c.file === file) : false;
    if (!isConflictedByLifecycle && !isTrackedByStore) {
      errorResponse(
        res,
        404,
        'urn:ok:error:no-conflict-tracked',
        'No conflict is tracked for this path.',
        {
          handler: 'sync-conflict-content',
          extensions: { file },
        },
      );
      return;
    }
    // Optional `?source=ytext` override: when the requested file maps to
    // a loaded doc, serve `ours` from the live Y.Text snapshot rather
    // than the git index. Covers the pre-conflict-unflushed-edits case
    // where Y.Text holds bytes the user typed after the last persistence
    // flush (persistence-during-conflict skip means those bytes don't
    // reach disk during conflict). Any other value (or no value) falls
    // back to the default `git show :2:` path so existing callers stay
    // backward-compatible.
    const source = url.searchParams.get('source');
    const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });

    // Working-tree-variant conflicts (pull-only B1) have no git index stages:
    // the branch already fast-forwarded to origin tip and the overlay rides
    // uncommitted on top. Serve `theirs`/`base` from the pinned tip/base blobs
    // and `ours` from the live doc (or disk when unloaded). The merge-native
    // stage path below is untouched for git-merge conflicts.
    const wtEntry = engine
      ?.getConflicts()
      .find((c) => c.file === file && c.variant === 'working-tree');
    if (wtEntry) {
      try {
        // A pinned SHA that fails to read is an unexpected failure (the blob was
        // reachable when the engine pinned it), NOT an absent blob. Returning ''
        // would misread it downstream as origin-deleted (`kind: 'modify-delete'`)
        // and steer the user into a `delete` resolution that removes their own
        // doc. Discriminate: `undefined` sha = genuinely no pinned blob (the
        // empty side of a delete/modify); a read failure on a present sha logs
        // and rethrows to the outer catch → 500, matching the merge-native
        // `showStage` discipline below.
        const readBlob = async (sha: string | undefined): Promise<string> => {
          if (!sha) return '';
          try {
            return await pg.raw(['cat-file', 'blob', sha]);
          } catch (err) {
            console.warn(
              JSON.stringify({
                event: 'conflict-content-readblob-failed',
                file,
                detail: err instanceof Error ? err.message : String(err),
                handler: 'sync-conflict-content',
              }),
            );
            throw err;
          }
        };
        const theirs = await readBlob(wtEntry.theirsSha);
        const base = await readBlob(wtEntry.baseSha);
        const docName = stripDocExtension(file);
        const loaded = hocuspocus.documents.get(docName);
        let ours = '';
        let oursPresent = false;
        let lifecycleStatus: string | null = null;
        if (loaded) {
          const rawStatus = loaded.getMap('lifecycle').get('status');
          lifecycleStatus =
            typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : null;
          const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
          if (ytextOurs !== null) {
            ours = ytextOurs;
            oursPresent = true;
          }
        } else {
          // Unloaded doc: the overlay is on disk (absent for a delete overlay).
          // Realpath-contain the read first — `file` is an origin-controlled
          // tracked path that could be a symlink escaping the working tree,
          // disclosing a foreign file. A SymlinkEscapeError propagates to the
          // outer catch → 500; the inner catch still handles the benign ENOENT
          // of a genuine delete overlay.
          // `allowShareableOkArtifact` matches the write sites in conflict-storage.
          // Without it a root-`.ok` conflict (now pinnable — `.ok/templates/*` is a
          // shareable artifact) throws SymlinkEscapeError here and surfaces as a
          // 500, wedging the project: the push gate holds while conflicts exist and
          // the conflict cannot be inspected to resolve it. `docs/.ok/...` was
          // unaffected, so a nested fixture would not have caught it.
          assertRealpathWithinDir(join(projectDir, file), projectDir, {
            allowShareableOkArtifact: isShareableOkArtifact,
          });
          try {
            ours = readFileSync(join(projectDir, file), 'utf-8');
            oursPresent = true;
          } catch (err) {
            // Only a genuine ENOENT is the empty side of a delete overlay
            // (`oursPresent=false` → `delete-modify`). Any other failure
            // (EACCES, EIO, a transient hiccup) misread as a delete would steer
            // the UI into `git rm`-ing the user's own doc — the exact
            // misclassification `readBlob` above and `showStage` below are
            // written to prevent — so log and rethrow to the outer catch → 500.
            if (errnoCode(err) !== 'ENOENT') {
              console.warn(
                JSON.stringify({
                  event: 'conflict-content-ours-read-failed',
                  file,
                  detail: err instanceof Error ? err.message : String(err),
                  handler: 'sync-conflict-content',
                }),
              );
              throw err;
            }
            oursPresent = false;
          }
        }
        // A locally-deleted file the tip modified is a delete/modify shape;
        // otherwise both sides hold content.
        const kind: 'both-modified' | 'delete-modify' | 'modify-delete' = !oursPresent
          ? 'delete-modify'
          : theirs.length === 0
            ? 'modify-delete'
            : 'both-modified';
        successResponse(
          res,
          200,
          SyncConflictContentSuccessSchema,
          { file, base, ours, theirs, kind, lifecycleStatus },
          { handler: 'sync-conflict-content' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read conflict content.',
          { handler: 'sync-conflict-content', cause: e },
        );
      }
      return;
    }

    // git stages: 1 = base, 2 = ours, 3 = theirs. Any may be missing for
    // delete/edit or add/add conflicts. Return a discriminated shape so the
    // caller can derive `kind` from stage presence — empty-string content is
    // otherwise indistinguishable from a legitimately-empty file, and the
    // earlier swallow-and-return-`''` shape silently mapped DU/UD into the
    // both-modified path.
    type StageResult = { present: false } | { present: true; content: string };
    // Discriminate "stage genuinely absent" (expected for DU/UD) from
    // "git subprocess failed" (transient: timeout, permissions, corruption).
    // Both map to `{ present: false }` and the caller derives `kind` from
    // it — without this discrimination, a transient git error silently
    // sets `kind` to `'delete-modify'`, the UI renders "Keep deletion" for
    // a file the user actually edited, and clicking it `git rm`s the file.
    // Log unexpected errors loudly so "user lost work after resolution"
    // incidents have a paper trail.
    async function showStage(stage: 1 | 2 | 3): Promise<StageResult> {
      try {
        return { present: true, content: await pg.raw(['show', `:${stage}:${file}`]) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Expected "stage absent" git error shapes from simple-git's stderr
        // passthrough. Observed in practice:
        //   - "pathspec '...' did not match any files known to git"
        //   - "path '...' is in the index, but not at stage <N>"
        //   - "path '...' exists on disk, but not in '<ref>'"
        // Full-phrase matches only — short fragments like "but not in"
        // alone could false-match unrelated git errors and silently
        // return `{ present: false }` for a real failure (data-loss
        // class). Locale-stable English fragments — git messages are
        // English-only.
        const isAbsent =
          /pathspec|did not match|exists on disk, but not in|is in the index, but not at stage/i.test(
            msg,
          );
        if (!isAbsent) {
          // Unexpected git failure (timeout, object corruption, permission,
          // EMFILE). Returning `{ present: false }` would drive `kind`
          // derivation downstream silently — a transient stage-2 failure
          // on a both-modified conflict would produce
          // `kind: 'delete-modify'`, the UI would render "Keep file
          // deleted" + "Restore with remote changes", and clicking
          // "Keep file deleted" would `git rm` a file the user edited.
          // Rethrow so the outer try converts to a 500;
          // the UI's `fetchFailed` state ("Couldn't load conflict
          // content — try reloading") handles it visibly.
          console.warn(
            JSON.stringify({
              event: 'showstage-unexpected-error',
              stage,
              file,
              detail: msg,
              handler: 'sync-conflict-content',
            }),
          );
          throw err;
        }
        return { present: false };
      }
    }
    try {
      const [baseResult, oursResult, theirsResult] = await Promise.all([
        showStage(1),
        showStage(2),
        showStage(3),
      ]);
      const base = baseResult.present ? baseResult.content : '';
      const theirs = theirsResult.present ? theirsResult.content : '';
      // Derive the stage-presence discriminator. Reaching this handler
      // requires the conflict-tracked guard above, so
      // at least one of stages 2/3 is always present — `neither` is
      // unreachable at runtime. The four branches are enumerated
      // explicitly (rather than collapsed into a trailing else) so the
      // `(false, false)` branch is self-documenting: it surfaces
      // `'both-modified'` as a defensive default; the caller branches
      // safely off that without a load-bearing assertNever.
      const kind: 'both-modified' | 'delete-modify' | 'modify-delete' =
        oursResult.present && theirsResult.present
          ? 'both-modified'
          : !oursResult.present && theirsResult.present
            ? 'delete-modify'
            : oursResult.present && !theirsResult.present
              ? 'modify-delete'
              : 'both-modified';
      let ours = oursResult.present ? oursResult.content : '';
      // Surface `lifecycleStatus` when the doc is loaded server-side so the
      // MCP `conflicts({ kind: 'content' })` caller can detect post-resolution state
      // (status === null after the conflict clears) without a second
      // round-trip. Only meaningful in the `source=ytext` branch — the
      // default `git show :2:` path is callable without a loaded doc.
      let lifecycleStatus: string | null = null;
      if (source === 'ytext') {
        const docName = stripDocExtension(file);
        const loaded = hocuspocus.documents.get(docName);
        if (loaded) {
          const rawStatus = loaded.getMap('lifecycle').get('status');
          lifecycleStatus =
            typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : null;
          // Gate the Y.Text substitution on the `kind` shape. The narrow
          // risk that motivated the gate: for DU (delete-modify, stage 2
          // absent), the file-watcher seeded Y.Text with `theirs` content
          // from disk (git leaves the remote version in the working tree
          // on modify/delete conflicts). Substituting Y.Text into `ours`
          // would equal `theirs` and silently un-delete the local intent.
          // Honest path for DU: leave `ours` empty; the `kind` discriminator
          // drives the UI affordance.
          //
          // For every OTHER shape — both-modified (real merge), modify-
          // delete (stage 2 present, only theirs absent), and the legacy
          // filesystem-marker conflict path (neither stage in git index;
          // `case 'conflict'` in the file-watcher fires on disk-markers
          // without a real merge) — Y.Text substitution is correct and
          // load-bearing. A previous `oursResult.present` gate over-
          // restricted: it broke the filesystem-marker case where a
          // mid-conflict Y.Text edit must surface despite no git stages
          // existing in the index.
          if (kind !== 'delete-modify') {
            const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
            if (ytextOurs !== null && !ytextHasConflictMarkers(ytextOurs)) {
              ours = ytextOurs;
            } else if (ytextOurs !== null) {
              // Structured signal so triage can spot when the marker-triple
              // detection fired and the handler fell back to git-index — the
              // alternative is silent. Pairs with `doc.name` for the
              // affected document.
              console.warn(
                JSON.stringify({
                  event: 'ytext-conflict-marker-detected',
                  'doc.name': docName,
                  handler: 'sync-conflict-content',
                }),
              );
            }
          }
        } else {
          log.warn(
            { docName },
            `[conflict-content] doc ${docName} not loaded; lifecycleStatus unavailable`,
          );
        }
      }
      successResponse(
        res,
        200,
        SyncConflictContentSuccessSchema,
        { file, base, ours, theirs, kind, lifecycleStatus },
        { handler: 'sync-conflict-content' },
      );
    } catch (e) {
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        'Failed to read conflict content.',
        {
          handler: 'sync-conflict-content',
          cause: e,
        },
      );
    }
  }

  const routes = {
    '/api/sync/status': handleSyncStatus,
    '/api/sync/trigger': handleSyncTrigger,
    '/api/sync/conflicts': handleSyncConflicts,
    '/api/sync/conflict-content': handleSyncConflictContent,
    '/api/sync/resolve-conflict': handleSyncResolveConflict,
    '/api/sync/resolve-blocking': handleSyncResolveBlocking,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes, {
    mutating: ['/api/sync/trigger', '/api/sync/resolve-conflict', '/api/sync/resolve-blocking'],
  });
}
