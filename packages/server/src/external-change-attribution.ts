/**
 * A short-lived claim that a disk change about to happen was made by a person.
 *
 * `applyExternalChange` attributes everything it ingests to `FILE_SYSTEM_WRITER`
 * — correct for its usual caller, the file watcher, which sees bytes appear and
 * cannot know why. But a merge-conflict resolution is a human decision the
 * server itself performed on the user's behalf: it writes the resolved content
 * to disk through git, and the watcher then ingests it like any other external
 * edit. The Timeline row lands as "File System", crediting nobody for what is
 * arguably the highest-stakes edit the product supports.
 *
 * A handler that is about to make such a write files a claim here first; the
 * ingest consumes it and attributes the row to that writer instead. The writer
 * id is an ordinary `principal-<UUID>` from the precedent #25 taxonomy — this
 * changes who a write is credited to, never what a writer id may look like.
 *
 * Deliberately weak by design. Claims are keyed by docName, single-use, and
 * expire; anything unmatched falls back to `FILE_SYSTEM_WRITER`. A lost race
 * therefore reproduces today's behaviour, while a stale claim can never
 * outlive its window and mis-credit a later unrelated edit. Wrong-but-silent
 * is the one outcome attribution must not have.
 */

import { getLogger } from './logger.ts';

const log = getLogger('external-change-attribution');

/** Who caused an imminent disk write, in `recordContributor`'s vocabulary. */
export interface ExternalChangeWriter {
  writerId: string;
  displayName: string;
  colorSeed: string;
}

interface Claim extends ExternalChangeWriter {
  expiresAtMs: number;
}

/**
 * How long a claim stays valid. The write and the watcher event that carries
 * it are decoupled by fs-event latency plus the sync engine's batch drain
 * (`setBatchInProgress` buffers the burst git emits), so this is a
 * generous multiple of the observed gap rather than a tight bound — an expired
 * claim costs attribution, never correctness.
 */
const CLAIM_TTL_MS = 30_000;

/** Bounds the map if a caller ever claims without a write following. */
const MAX_CLAIMS = 256;

const claims = new Map<string, Claim>();

function pruneExpired(nowMs: number): void {
  for (const [docName, claim] of claims) {
    if (claim.expiresAtMs <= nowMs) claims.delete(docName);
  }
}

/**
 * Record that the next external change to `docName` is attributable to
 * `writer`. Overwrites any outstanding claim for the same doc: two resolutions
 * racing on one file means the later actor is the one whose bytes land.
 *
 * `ttlMs` exists because not every claimed write produces an ingest to consume
 * it. A resolve can leave the bytes unchanged, delete the file, or touch a doc
 * nobody has open — and consumption happens only on a loaded doc whose bytes
 * actually changed. An unconsumed claim then sits for its full window waiting
 * to mis-credit whoever edits that file next. A caller that knows its write is
 * imminent should say so with a window sized to the ingest, not to the worst
 * case: an expired claim costs attribution, which this module has always
 * preferred to crediting the wrong person.
 */
export function claimExternalChange(
  docName: string,
  writer: ExternalChangeWriter,
  nowMs: number = Date.now(),
  ttlMs: number = CLAIM_TTL_MS,
): void {
  pruneExpired(nowMs);
  // Oldest-first eviction (Map preserves insertion order) — a flood of
  // unconsumed claims must not grow without bound.
  if (claims.size >= MAX_CLAIMS && !claims.has(docName)) {
    const oldest = claims.keys().next();
    if (!oldest.done) claims.delete(oldest.value);
  }
  claims.set(docName, { ...writer, expiresAtMs: nowMs + ttlMs });
}

/**
 * Consume the claim for `docName`, if one is live. Single-use: a second
 * external change to the same doc is a genuinely new event and attributing it
 * to the same actor would be a guess.
 */
export function takeExternalChangeAttribution(
  docName: string,
  nowMs: number = Date.now(),
): ExternalChangeWriter | undefined {
  const claim = claims.get(docName);
  if (!claim) return undefined;
  claims.delete(docName);
  if (claim.expiresAtMs <= nowMs) {
    // Worth a line: a claim that consistently expires means the window no
    // longer matches how long a resolution takes to reach the watcher, and the
    // symptom (rows silently reading "File System" again) is otherwise mute.
    log.debug({ docName }, 'external-change claim expired before its write arrived');
    return undefined;
  }
  const { expiresAtMs: _expiresAtMs, ...writer } = claim;
  return writer;
}

/**
 * Drop the claim for `docName` without consuming it.
 *
 * A claim is filed before the write it describes, so a write that then fails
 * leaves one standing with no bytes coming. The next genuine external edit to
 * that doc inside the TTL would consume it and credit the actor for someone
 * else's change — the wrong-but-silent outcome this module exists to avoid.
 */
export function releaseExternalChangeClaim(docName: string): void {
  claims.delete(docName);
}

/** Test seam — drops every outstanding claim. */
export function clearExternalChangeClaims(): void {
  claims.clear();
}
