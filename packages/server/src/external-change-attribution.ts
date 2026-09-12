/**
 * The writer id is an ordinary `principal-<UUID>` from the precedent #25 taxonomy — this changes
 * who a write is credited to, never what a writer id may look like.
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
