import { fnv1aDigest } from './hash-util.ts';

export type BridgeInvariantSite = 'observer-b' | 'persistence' | 'test-harness';

export interface BridgeInvariantViolation {
  site: BridgeInvariantSite;
  origin?: unknown;
  docName?: string;
  ytextSnapshot: string;
  fragmentMdSnapshot: string;
  unifiedDiff: string;
  stack: string | undefined;
}

export interface BridgeInvariantLogPayload {
  event: 'bridge-invariant-violation';
  site: BridgeInvariantSite;
  'doc.name': string | null;
  'tolerance-class-attempted': 'untracked';
  'normalize-equal-modulo-tolerance': false;
  ytextLen: number;
  fragmentLen: number;
  ytextHash: string;
  fragmentHash: string;
  diff?: string;
  redacted: boolean;
  timestamp: string;
}

export function toBridgeInvariantLog(
  violation: BridgeInvariantViolation,
  opts?: { verbose?: boolean; nowMs?: number },
): BridgeInvariantLogPayload {
  const verbose = opts?.verbose === true;
  const timestamp =
    opts?.nowMs !== undefined ? new Date(opts.nowMs).toISOString() : new Date().toISOString();
  const base: BridgeInvariantLogPayload = {
    event: 'bridge-invariant-violation',
    site: violation.site,
    'doc.name': violation.docName ?? null,
    'tolerance-class-attempted': 'untracked',
    'normalize-equal-modulo-tolerance': false,
    ytextLen: violation.ytextSnapshot.length,
    fragmentLen: violation.fragmentMdSnapshot.length,
    ytextHash: fnv1aDigest(violation.ytextSnapshot),
    fragmentHash: fnv1aDigest(violation.fragmentMdSnapshot),
    redacted: !verbose,
    timestamp,
  };
  if (verbose) {
    return { ...base, diff: violation.unifiedDiff };
  }
  return base;
}

export type InvariantViolation = BridgeInvariantViolation;

export class BridgeInvariantViolationError extends Error {
  readonly violation: BridgeInvariantViolation;
  constructor(info: BridgeInvariantViolation) {
    const originLabel =
      typeof info.origin === 'string'
        ? info.origin
        : ((info.origin as { context?: { origin?: string } })?.context?.origin ?? 'unknown-object');
    const docPart = info.docName ? ` doc='${info.docName}'` : '';
    super(
      `Bridge invariant violated [site='${info.site}'${docPart}, origin='${originLabel}'].\n` +
        `  Y.Text (${info.ytextSnapshot.length} chars): ${info.ytextSnapshot.slice(0, 200)}...\n` +
        `  Fragment (${info.fragmentMdSnapshot.length} chars): ${info.fragmentMdSnapshot.slice(0, 200)}...\n` +
        `  Diff:\n${info.unifiedDiff}`,
    );
    this.name = 'BridgeInvariantViolationError';
    this.violation = info;
  }
}
