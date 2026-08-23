/**
 * Machine-local divergence baselines for skills whose upstream is a harness
 * plugin.
 *
 * The plugin's own bytes cannot be the Modified baseline: a repo that fans
 * plugin skills into its skills dirs legitimately rewrites frontmatter and
 * injects a provenance banner on the way, so byte-comparing against the plugin
 * flags every synced copy as modified when nobody modified anything. Dropping
 * the signal entirely was worse — a real hand-edit then goes unflagged, and the
 * next sync run silently destroys it.
 *
 * The sound baseline is the copy's own FIRST-SEEN state, re-anchored whenever
 * the plugin moves:
 *
 *   - local changed, plugin unchanged → a hand-edit. The fan-out is
 *     deterministic for a fixed upstream, so re-running it reproduces the same
 *     bytes; only a person (or a changed generator, rare and self-healing)
 *     moves the local copy while the upstream stands still. → Modified.
 *   - plugin changed → the pair re-baselines to the current state, so an
 *     update wave never flags anything. An edit made in the same window as an
 *     upstream bump is absorbed — acceptable, since that edit was about to be
 *     overwritten anyway.
 *
 * Stored under `.ok/local/` (machine-local, never committed): the baseline is
 * an observation this machine made, not a fact about the project. A fresh
 * machine baselines to whatever it first sees, so pre-existing divergence reads
 * clean there — the signal is "changed since OK started watching", and says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tracedMkdirSync, tracedWriteFileSync } from './fs-traced.ts';

interface BaselinePair {
  /** The LOCAL copy's content hash when this pair was anchored. */
  readonly local: string;
  /** The PLUGIN bundle's content hash the pair was anchored against. */
  readonly upstream: string;
}

type BaselineFile = Record<string, BaselinePair>;

const REL_PATH = ['.ok', 'local', 'plugin-skill-baselines.json'] as const;

function fileOf(contentDir: string): string {
  return join(contentDir, ...REL_PATH);
}

function readBaselines(contentDir: string): BaselineFile {
  try {
    const p = fileOf(contentDir);
    if (!existsSync(p)) return {};
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Null-prototype: keys come from JSON on disk, and a `__proto__` key on a
    // plain object re-parents it instead of storing an entry.
    const out: BaselineFile = Object.create(null) as BaselineFile;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as BaselinePair).local === 'string' &&
        typeof (v as BaselinePair).upstream === 'string'
      )
        out[k] = { local: (v as BaselinePair).local, upstream: (v as BaselinePair).upstream };
    }
    return out;
  } catch {
    // A corrupt cache is an empty cache: everything re-baselines to current,
    // which is the same state a fresh machine starts in.
    return {};
  }
}

/**
 * The decision, pure so it is testable without a filesystem: given the stored
 * pair (or none) and the two current hashes, is the local copy hand-modified,
 * and what should the stored pair become?
 */
export function decidePluginBaseline(
  stored: BaselinePair | undefined,
  localHash: string,
  upstreamHash: string,
): { modified: boolean; next: BaselinePair } {
  // First sight, or the upstream moved: anchor to now. Whatever the local copy
  // looks like at this moment is the new "unedited" state.
  if (stored === undefined || stored.upstream !== upstreamHash)
    return { modified: false, next: { local: localHash, upstream: upstreamHash } };
  // Upstream unchanged: any local movement is a hand-edit. The pair keeps the
  // ORIGINAL local hash so reverting the edit reads clean again.
  return { modified: localHash !== stored.local, next: stored };
}

/**
 * Baseline lookups for one enumeration pass: reads the file once, batches every
 * write, and flushes at most one file write per pass — `/api/skills` is hot and
 * runs this for every plugin-derived skill it lists.
 */
export function openPluginBaselines(contentDir: string): {
  isModified: (
    scope: 'project' | 'global',
    name: string,
    localHash: string,
    upstreamHash: string,
  ) => boolean;
  flush: () => void;
} {
  const baselines = readBaselines(contentDir);
  let dirty = false;
  return {
    isModified(scope, name, localHash, upstreamHash) {
      const key = `${scope}:${name}`;
      const { modified, next } = decidePluginBaseline(baselines[key], localHash, upstreamHash);
      const prev = baselines[key];
      if (prev === undefined || prev.local !== next.local || prev.upstream !== next.upstream) {
        baselines[key] = next;
        dirty = true;
      }
      return modified;
    },
    flush() {
      if (!dirty) return;
      dirty = false;
      try {
        tracedMkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
        tracedWriteFileSync(fileOf(contentDir), `${JSON.stringify(baselines, null, 2)}\n`);
      } catch {
        // Machine-local cache only — failing to persist costs re-baselining
        // after a restart, never a wrong answer within this session.
      }
    },
  };
}
