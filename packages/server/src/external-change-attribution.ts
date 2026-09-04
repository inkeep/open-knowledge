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

export interface ExternalChangeWriter {
  writerId: string;
  displayName: string;
  colorSeed: string;
}

interface Claim extends ExternalChangeWriter {
  expiresAtMs: number;
}

const CLAIM_TTL_MS = 30_000;

const MAX_CLAIMS = 256;

const claims = new Map<string, Claim>();

function pruneExpired(nowMs: number): void {
  for (const [docName, claim] of claims) {
    if (claim.expiresAtMs <= nowMs) claims.delete(docName);
  }
}

export function claimExternalChange(
  docName: string,
  writer: ExternalChangeWriter,
  nowMs: number = Date.now(),
  ttlMs: number = CLAIM_TTL_MS,
): void {
  pruneExpired(nowMs);
  if (claims.size >= MAX_CLAIMS && !claims.has(docName)) {
    const oldest = claims.keys().next();
    if (!oldest.done) claims.delete(oldest.value);
  }
  claims.set(docName, { ...writer, expiresAtMs: nowMs + ttlMs });
}

export function takeExternalChangeAttribution(
  docName: string,
  nowMs: number = Date.now(),
): ExternalChangeWriter | undefined {
  const claim = claims.get(docName);
  if (!claim) return undefined;
  claims.delete(docName);
  if (claim.expiresAtMs <= nowMs) {
    log.debug({ docName }, 'external-change claim expired before its write arrived');
    return undefined;
  }
  const { expiresAtMs: _expiresAtMs, ...writer } = claim;
  return writer;
}

export function releaseExternalChangeClaim(docName: string): void {
  claims.delete(docName);
}

export function clearExternalChangeClaims(): void {
  claims.clear();
}
