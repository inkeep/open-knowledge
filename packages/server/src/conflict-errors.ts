/**
 * Conflict-aware write-surface refusal: typed error + RFC 9457 envelope helper.
 *
 * Every mutating write surface (write, edit, agent_patch,
 * agent_undo, rollback, rename, delete, template) refuses mutations against a
 * doc whose `lifecycle.status === 'conflict'`. The refusal flows as one
 * canonical typed throw (`DocInConflictError`) and one canonical wire shape
 * (the slim RFC 9457 envelope below). Centralizing both here keeps the gate
 * uniform across handlers and makes the meta-test that scans for the gate
 * possible (one error class → one catch site per handler).
 *
 * Wire shape — slim envelope. The body carries `file` + `resolutionOptions`
 * extensions flat at the top level (RFC 9457 §3.2 spread semantics produced
 * by `errorResponse(res, ..., { extensions: ... })`). It deliberately does
 * NOT embed merge stages (`base` / `ours` / `theirs`) — agents call the
 * separate `conflicts({ kind: "content" })` read when they want the stages.
 *
 *   {
 *     "type": "urn:ok:error:doc-in-conflict",
 *     "title": "Document is in conflict.",
 *     "status": 409,
 *     "detail": "The document is in a merge-conflict state. Call conflicts({ kind: "content" }) + resolve_conflict before retrying.",
 *     "file": "<.md path>",
 *     "resolutionOptions": ["mine", "theirs", "content", "delete"]
 *   }
 *
 * `resolutionOptions` mirrors the `ResolveStrategy` enum used by
 * `/api/sync/resolve-conflict`. Keep this array in sync with the strategy
 * enum if either changes.
 */

import type { ServerResponse } from 'node:http';
import type { Document } from '@hocuspocus/server';
import type * as Y from 'yjs';
import type { ResolveStrategy } from './conflict-storage.ts';
import { stripDocExtension } from './doc-extensions.ts';
import { errorResponse } from './http/error-response.ts';

/**
 * Strategy tokens an agent can pick when calling `resolve_conflict`. Mirror
 * of the `ResolveStrategy` enum on the sync side. Surfaced inline in the
 * 409 envelope so agents discover available strategies without a second
 * round trip.
 *
 * Two compile-time guards work together to keep the array honest:
 *   1. `satisfies readonly ResolveStrategy[]` — each element must be a
 *      valid `ResolveStrategy` value (catches typos and renames).
 *   2. `_ExhaustiveResolveStrategy` below — every `ResolveStrategy` member
 *      must appear in the array (catches additions). `Exclude<...>`
 *      resolves to `never` only when the array covers the union; if a new
 *      strategy is added without updating this array, the type resolves
 *      to the missing member's literal and the assignment errors out.
 */
export const RESOLUTION_OPTIONS = [
  'mine',
  'theirs',
  'content',
  'delete',
] as const satisfies readonly ResolveStrategy[];

type _ExhaustiveResolveStrategy =
  Exclude<ResolveStrategy, (typeof RESOLUTION_OPTIONS)[number]> extends never
    ? true
    : [
        'RESOLUTION_OPTIONS missing ResolveStrategy member:',
        Exclude<ResolveStrategy, (typeof RESOLUTION_OPTIONS)[number]>,
      ];
const _exhaustiveResolveStrategy: _ExhaustiveResolveStrategy = true;

/**
 * The structural conflict gate: a doc is "in conflict" iff its
 * `Y.Map('lifecycle').get('status') === 'conflict'`. Every mutating write
 * surface reads this via the helper rather than re-deriving the literal.
 *
 * Delegates to `frozenDocLifecycleStatus` — the single `lifecycle.status`
 * read site — so adding new lifecycle discriminators (`deleted-upstream`,
 * `renamed`, future block-conflict shadows) goes through the
 * `FROZEN_LIFECYCLE_STATUSES` registry below, never a scattered compare.
 */
export function isDocInConflict(document: Document): boolean {
  return frozenDocLifecycleStatus(document) === 'conflict';
}

/**
 * Lifecycle statuses under which the persistence spine intentionally holds
 * memory != disk and skips stores: externally deleted / renamed docs must
 * not be rewritten at their old path, and conflict docs keep merge markers
 * on disk for the resolver UI. Registry-first (mirroring
 * `RESOLUTION_OPTIONS` above) so a new frozen status is added in exactly
 * one place and every reader — `storeDocumentNow`'s guard, the staleness
 * watchdog, `isDocInConflict` — picks it up together.
 */
export const FROZEN_LIFECYCLE_STATUSES = ['deleted-upstream', 'renamed', 'conflict'] as const;
export type FrozenLifecycleStatus = (typeof FROZEN_LIFECYCLE_STATUSES)[number];

function isFrozenLifecycleStatus(value: unknown): value is FrozenLifecycleStatus {
  return (FROZEN_LIFECYCLE_STATUSES as readonly unknown[]).includes(value);
}

/**
 * The frozen lifecycle status a doc currently carries, or null when the
 * doc is writable. Together with `isDocInConflict` (which delegates here)
 * this is the single read site for `lifecycle.status` discriminators —
 * adding a new lifecycle status goes through `FROZEN_LIFECYCLE_STATUSES`
 * above, never a scattered string compare.
 */
export function frozenDocLifecycleStatus(document: Y.Doc): FrozenLifecycleStatus | null {
  const status = document.getMap('lifecycle').get('status');
  return isFrozenLifecycleStatus(status) ? status : null;
}

/**
 * Typed throw from any mutating write surface when the target doc's
 * `lifecycle.status === 'conflict'`. Carries the path of the conflicted
 * `.md` file so the HTTP boundary can surface it as the `file` extension
 * member on the RFC 9457 envelope.
 *
 * Throw shape rather than return-value branching: each gated write surface
 * has a different return shape (void, `{ saved: true }`, an SHA, …) — a
 * thrown error is the one shape that composes uniformly across all of
 * them, caught at the HTTP handler boundary and translated via
 * `respondDocInConflict`.
 */
export class DocInConflictError extends Error {
  readonly file: string;
  override readonly name = 'DocInConflictError' as const;

  constructor(opts: { file: string }) {
    super(`Document is in conflict: ${opts.file}`);
    this.file = opts.file;
  }
}

/**
 * Translate a `DocInConflictError` into the slim RFC 9457 problem+json
 * envelope at HTTP 409. The exact wire shape is a 1-way-door contract —
 * see the file header for the literal body.
 *
 * Callers wrap their handler body in `try { ... } catch (err) { if (err
 * instanceof DocInConflictError) { respondDocInConflict(res, err, 'handler-name'); return; } throw err; }`.
 *
 * Emits the structured log event `doc-in-conflict-write-refused` on every
 * refusal — the single emission site so the "during-conflict writes
 * prevented" counter, grouped by handler, sees every refusal regardless
 * of which gate fired. Centralizing the emit here means any new gate
 * that routes through this helper joins the metric for free; gates that
 * bypass it (and emit their own event) would silently drop from the
 * grouped count.
 *
 * @param res - The Node HTTP response. `errorResponse` enforces the
 *   `headersSent` triple-guard.
 * @param err - The thrown error carrying the `file` payload.
 * @param handler - Handler tag forwarded to `ok.api.error.count{handler}`
 *   for telemetry attribution AND to the structured log event so the
 *   refusal counter can group by call site.
 */
export function respondDocInConflict(
  res: ServerResponse,
  err: DocInConflictError,
  handler: string,
): void {
  console.warn(
    JSON.stringify({
      event: 'doc-in-conflict-write-refused',
      handler,
      'doc.name': stripDocExtension(err.file),
    }),
  );
  errorResponse(res, 409, 'urn:ok:error:doc-in-conflict', 'Document is in conflict.', {
    handler,
    detail:
      'The document is in a merge-conflict state. Call conflicts({ kind: "content" }) + resolve_conflict before retrying.',
    extensions: {
      file: err.file,
      resolutionOptions: RESOLUTION_OPTIONS,
    },
  });
}

/**
 * Typed throw when a submitted resolution still carries a complete conflict
 * block. A permanent rejection of the caller's bytes, not a failure of ours —
 * which is the whole reason it needs its own type. Thrown bare, it landed in
 * the resolve handler's generic catch and became a 500: it moved the 5xx
 * alerting signal, and told an agent — whose own `resolve_conflict` contract
 * reads "500 indicates commit failure … the file may have been resolved by
 * another session" — that a permanent input error was a transient one worth
 * retrying.
 */
export class ConflictMarkersInContentError extends Error {
  readonly file: string;
  override readonly name = 'ConflictMarkersInContentError' as const;

  constructor(opts: { file: string }) {
    super(`Resolution for ${opts.file} still contains conflict markers`);
    this.file = opts.file;
  }
}

/**
 * Typed throw when the store tracks no conflict for the requested path —
 * resolved by another session, or simply the wrong path.
 *
 * Bare, it reached the resolve handler's generic catch as a 500, which reads to
 * an agent as a transient commit failure worth retrying and moves the 5xx
 * alerting signal for what is a caller-side path error. `handleSyncConflictContent`
 * already answers this exact condition with 404 `no-conflict-tracked`; typing the
 * throw lets the resolve path say the same thing.
 *
 * Typing it also makes guard ORDER stop mattering. While `!entry` threw bare,
 * checking it before the marker validation turned a permanent content error into
 * a transient-looking 500, and checking it after told a caller with a stale path
 * to fix bytes that were never the problem. With both errors typed, each
 * ordering reports something true.
 */
export class NoConflictTrackedError extends Error {
  readonly file: string;
  override readonly name = 'NoConflictTrackedError' as const;

  constructor(opts: { file: string }) {
    super(`[conflicts] no conflict tracked for file: ${opts.file}`);
    this.file = opts.file;
  }
}
