import DiffMatchPatch from 'diff-match-patch';
import { diff3Merge } from 'node-diff3';
import { fnv1aDigest } from './hash-util.ts';

const dmp = new DiffMatchPatch();
dmp.Match_Threshold = 0.5;

export function mergeThreeWay(baseline: string, userText: string, agentText: string): string {
  const result = mergeThreeWayImpl(baseline, userText, agentText);
  assertContentPreservation(baseline, userText, agentText, result);
  return result;
}

function mergeThreeWayImpl(baseline: string, userText: string, agentText: string): string {
  if (baseline === userText) return agentText;
  if (baseline === agentText) return userText;
  if (userText === agentText) return userText;

  const userLines = userText.split('\n');
  const baseLines = baseline.split('\n');
  const agentLines = agentText.split('\n');
  const regions = diff3Merge(userLines, baseLines, agentLines);

  const parts: string[] = [];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    if ('ok' in region && region.ok) {
      parts.push(region.ok.join('\n'));
    } else if ('conflict' in region && region.conflict) {
      const conflictBase = region.conflict.o.join('\n');
      const conflictUser = region.conflict.a.join('\n');
      const conflictAgent = region.conflict.b.join('\n');
      parts.push(mergeConflictRegion(conflictBase, conflictUser, conflictAgent));
    }
  }

  return parts.join('\n');
}


export type BridgeMergeContentLossSide = 'user' | 'agent';

export type BridgeMergeContentLossWhich = 'substring' | 'order';

export interface BridgeMergeContentLossInfo {
  baseline: string;
  userText: string;
  agentText: string;
  result: string;
  lostSubstrings: string[];
  which: BridgeMergeContentLossWhich;
  side: BridgeMergeContentLossSide;
}

interface RedactedLostSubstring {
  len: number;
  digest: string;
}

export interface BridgeMergeContentLossLogPayload {
  event: 'bridge-merge-content-loss';
  which: BridgeMergeContentLossWhich;
  side: BridgeMergeContentLossSide;
  baselineLen: number;
  userTextLen: number;
  agentTextLen: number;
  resultLen: number;
  lostSubstrings: RedactedLostSubstring[] | string[];
  redacted: boolean;
}

function redactLostSubstrings(lost: string[]): RedactedLostSubstring[] {
  return lost.map((s) => ({ len: s.length, digest: fnv1aDigest(s) }));
}

export class BridgeMergeContentLossError extends Error {
  readonly info: BridgeMergeContentLossInfo;

  constructor(info: BridgeMergeContentLossInfo) {
    const preview = info.lostSubstrings
      .map((s) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s))
      .join(', ');
    super(`Bridge merge content loss (which=${info.which}, side=${info.side}): ${preview}`);
    this.name = 'BridgeMergeContentLossError';
    this.info = info;
  }

  toLog(opts?: { verbose?: boolean }): BridgeMergeContentLossLogPayload {
    const verbose = opts?.verbose === true;
    return {
      event: 'bridge-merge-content-loss',
      which: this.info.which,
      side: this.info.side,
      baselineLen: this.info.baseline.length,
      userTextLen: this.info.userText.length,
      agentTextLen: this.info.agentText.length,
      resultLen: this.info.result.length,
      lostSubstrings: verbose
        ? this.info.lostSubstrings
        : redactLostSubstrings(this.info.lostSubstrings),
      redacted: !verbose,
    };
  }
}

function extractUniqueSegments(base: string, derived: string): string[] {
  if (base === derived) return [];
  const diffs = dmp.diff_main(base, derived);
  dmp.diff_cleanupSemantic(diffs);
  const out: string[] = [];
  for (const [op, data] of diffs) {
    if (op !== 1 /* INSERT */) continue;
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      out.push(trimmed);
    }
  }
  return out;
}

function findReorderedSegment(result: string, segments: string[]): string | null {
  let cursor = 0;
  for (const seg of segments) {
    const idx = result.indexOf(seg, cursor);
    if (idx < 0) {
      const earlierIdx = result.indexOf(seg);
      if (earlierIdx < 0) continue; // absent → substring check reports it
      return seg; // appears earlier → order violation
    }
    cursor = idx + seg.length;
  }
  return null;
}

/**
 * Invariant (c) + order side-check: every maximal-unique-substring of
 * `(userText \ baseline)` and `(agentText \ baseline)` appears in `result`,
 * and each side's segments appear in result in the same relative order
 * they appear in their source. Throws `BridgeMergeContentLossError`
 * on the first violation; callers decide environment policy.
 *
 * Complexity: O(n log n) for DMP diff per side + O(k · m) for substring
 * checks (k = segment count, m = result length) + O(k) for order check.
 * Empirically sub-millisecond on ~10 KB markdown with k ≤ ~10 segments.
 */
export function assertContentPreservation(
  baseline: string,
  userText: string,
  agentText: string,
  result: string,
): void {
  const userSegments = extractUniqueSegments(baseline, userText);
  const agentSegments = extractUniqueSegments(baseline, agentText);

  const userMissing = userSegments.filter((s) => !result.includes(s));
  if (userMissing.length > 0) {
    throw new BridgeMergeContentLossError({
      baseline,
      userText,
      agentText,
      result,
      lostSubstrings: userMissing,
      which: 'substring',
      side: 'user',
    });
  }
  const agentMissing = agentSegments.filter((s) => !result.includes(s));
  if (agentMissing.length > 0) {
    throw new BridgeMergeContentLossError({
      baseline,
      userText,
      agentText,
      result,
      lostSubstrings: agentMissing,
      which: 'substring',
      side: 'agent',
    });
  }

  const userReordered = findReorderedSegment(result, userSegments);
  if (userReordered !== null) {
    throw new BridgeMergeContentLossError({
      baseline,
      userText,
      agentText,
      result,
      lostSubstrings: [userReordered],
      which: 'order',
      side: 'user',
    });
  }
  const agentReordered = findReorderedSegment(result, agentSegments);
  if (agentReordered !== null) {
    throw new BridgeMergeContentLossError({
      baseline,
      userText,
      agentText,
      result,
      lostSubstrings: [agentReordered],
      which: 'order',
      side: 'agent',
    });
  }
}

function mergeConflictRegion(base: string, user: string, agent: string): string {
  if (user === '') return agent;
  if (agent === '') return user;

  const patches = dmp.patch_make(base, user);
  const [merged, flags] = dmp.patch_apply(patches, agent);

  if (flags.some((f) => !f)) {
    console.warn(
      JSON.stringify({
        event: 'bridge-merge-patch-drop',
        applied: flags.filter(Boolean).length,
        total: flags.length,
        regionSize: agent.length,
      }),
    );
  }

  return merged;
}
