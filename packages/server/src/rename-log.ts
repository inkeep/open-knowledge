/**
 * Rename log — durable index of per-rename `(from, to)` mappings.
 *
 * Persisted as JSONL at `<shadowDir>/renames.jsonl`. Each line is one
 * `RenameLogEntry`. Atomic append uses `tracedAppendFileSync` with `flag: 'a'`
 * (POSIX O_APPEND) — the OK server lock at `<contentDir>/.ok/server.lock`
 * provides single-writer guarantee. Boot-time loader is fail-open: malformed
 * lines log a warning and are skipped, partial trailing line is dropped.
 *
 * In-memory index shape: `Map<to, RenameLogEntry>` for O(1) per-step chain
 * lookup. Forward-compatible reverse accessor: `Map<from, RenameLogEntry[]>`
 * built from the same source — a single rename can be the predecessor of
 * multiple later renames if a name is reused after a rename and renamed again.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOkActors } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import {
  tracedAppendFileSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import type { ShadowHandle } from './shadow-repo.ts';
import { shadowGit } from './shadow-repo.ts';
import { getMeter, withSpan } from './telemetry.ts';

let _liveEntriesGauge: ReturnType<ReturnType<typeof getMeter>['createUpDownCounter']> | null = null;
function liveEntriesGauge(): ReturnType<ReturnType<typeof getMeter>['createUpDownCounter']> {
  _liveEntriesGauge ||= getMeter().createUpDownCounter('rename.log_entries_total', {
    description: 'Live rename-log entry count after each append / GC pass',
  });
  return _liveEntriesGauge;
}

let _gcDroppedCounter: ReturnType<ReturnType<typeof getMeter>['createCounter']> | null = null;
function gcDroppedCounter(): ReturnType<ReturnType<typeof getMeter>['createCounter']> {
  _gcDroppedCounter ||= getMeter().createCounter('rename.log_gc_dropped_total', {
    description: 'Cumulative count of rename-log entries dropped by reachability GC',
  });
  return _gcDroppedCounter;
}

/**
 * Per-line schema for `<shadowDir>/renames.jsonl`. `v: 1` is the sole schema
 * version; bump to introduce breaking changes.
 *
 * `commitSha` is `''` between append (inside the rewrite spine's recovery
 * envelope) and the L2-drain backfill that follows. `expandPredecessors`
 * skips entries with empty `commitSha` — chain truncates at that step until
 * backfill completes.
 */
export interface RenameLogEntry {
  v: 1;
  from: string;
  to: string;
  at: string;
  commitSha: string;
  branch: string;
  /**
   * Deterministic ID shared by every entry produced by the same rewrite-spine
   * call. Derived as `deriveGroupId(commitSha, branch, at)` so a folder rename
   * (which fans out into N file-rename entries inside a single
   * `_performManagedRenameForDocs` call) collapses back to one logical event
   * for the timeline. The boot rebuild path mirrors this — entries
   * reconstructed from a single `rename:` commit body share one groupId.
   */
  groupId: string;
  kind: 'file' | 'folder';
  actor: {
    writerId: string;
    displayName: string;
  };
}

/**
 * Hard size cap above which the next append should force a GC sweep.
 * Lives in this module so the GC trigger sites can import it.
 */
export const RENAME_LOG_HARD_CAP_BYTES = 5 * 1024 * 1024;

/**
 * Soft per-line cap. JSON-encoded entries are typically ~250 bytes; values
 * over 4 KB indicate a malformed actor or absurdly long path. Used as an
 * append-time defensive guard, NOT a parse-time filter (boot loader is
 * lenient).
 */
const RENAME_LOG_MAX_LINE_BYTES = 4 * 1024;

const RENAME_LOG_FILENAME = 'renames.jsonl';

/**
 * In-memory index. `byTo` is the canonical chain-step lookup. `byFrom` is
 * forward-compat: a single `from` can be the source of multiple later
 * renames if the name is reused and renamed again. Both maps are kept in
 * sync by every append + load + GC pass.
 */
export interface RenameLogIndex {
  byTo: Map<string, RenameLogEntry>;
  byFrom: Map<string, RenameLogEntry[]>;
}

export function createEmptyIndex(): RenameLogIndex {
  return { byTo: new Map(), byFrom: new Map() };
}

/**
 * Compute the on-disk path for the rename log given the shadow directory
 * (the value `resolveShadowDir(projectRoot)` returns).
 */
export function renameLogPath(shadowDir: string): string {
  return resolve(shadowDir, RENAME_LOG_FILENAME);
}

/**
 * Validate a parsed JSON object against the `RenameLogEntry` schema. Returns
 * the typed entry or `null` on schema violation. Used by both the boot loader
 * and the append helper's pre-write guard.
 */
function validateEntry(obj: unknown): RenameLogEntry | null {
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.from !== 'string' || o.from.length === 0) return null;
  if (typeof o.to !== 'string' || o.to.length === 0) return null;
  // A self-rename creates a self-cycle in byTo and would displace any
  // legitimate predecessor entry at the same key. The upstream rewrite spine
  // already guards `fromPath === toPath`; reject here as defense-in-depth at
  // the persistence boundary against manual JSONL edits or future bugs.
  if (o.from === o.to) return null;
  if (typeof o.at !== 'string' || o.at.length === 0) return null;
  if (typeof o.commitSha !== 'string') return null;
  // Empty commitSha is the lazy-population sentinel and must remain valid;
  // any other value must be a 40-char hex SHA — defends against manual JSONL
  // edits whose corruption would only surface later as `git show` errors.
  if (o.commitSha !== '' && !/^[0-9a-f]{40}$/.test(o.commitSha)) return null;
  if (typeof o.branch !== 'string' || o.branch.length === 0) return null;
  if (typeof o.groupId !== 'string' || o.groupId.length === 0) return null;
  if (o.kind !== 'file' && o.kind !== 'folder') return null;
  if (o.actor === null || typeof o.actor !== 'object') return null;
  const actor = o.actor as Record<string, unknown>;
  if (typeof actor.writerId !== 'string' || actor.writerId.length === 0) return null;
  if (typeof actor.displayName !== 'string') return null;
  return {
    v: 1,
    from: o.from,
    to: o.to,
    at: o.at,
    commitSha: o.commitSha,
    branch: o.branch,
    groupId: o.groupId,
    kind: o.kind,
    actor: { writerId: actor.writerId, displayName: actor.displayName },
  };
}

function removeFromByFrom(index: RenameLogIndex, entry: RenameLogEntry): void {
  const bucket = index.byFrom.get(entry.from);
  if (!bucket) return;
  const filtered = bucket.filter((e) => e !== entry);
  if (filtered.length === 0) index.byFrom.delete(entry.from);
  else index.byFrom.set(entry.from, filtered);
}

function indexRemove(index: RenameLogIndex, entry: RenameLogEntry): void {
  index.byTo.delete(entry.to);
  removeFromByFrom(index, entry);
}

function indexInsert(index: RenameLogIndex, entry: RenameLogEntry): void {
  // If `byTo` already maps this `to` to a previous entry, drop that entry
  // from its `byFrom` bucket before overwriting — otherwise the previous
  // entry would dangle in the reverse index, mapping a `from` to a `to`
  // that no longer points back to it. Don't call indexRemove here: byTo
  // gets overwritten by the set() below, so a separate delete is wasted
  // work and a partial-failure window between delete and set.
  const displaced = index.byTo.get(entry.to);
  if (displaced) removeFromByFrom(index, displaced);
  index.byTo.set(entry.to, entry);
  const fromBucket = index.byFrom.get(entry.from);
  if (fromBucket) fromBucket.push(entry);
  else index.byFrom.set(entry.from, [entry]);
}

/**
 * Load the rename-log JSONL into an in-memory index. Fail-open: missing
 * file → empty index; zero-byte file → empty index; malformed line → log
 * a warning and skip; trailing line without newline → drop and warn.
 */
export function loadRenameLogIndex(shadowDir: string): RenameLogIndex {
  const index = createEmptyIndex();
  const path = renameLogPath(shadowDir);
  if (!existsSync(path)) return index;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    console.warn(`[rename-log] WARN: failed to read ${path}, treating as empty:`, err);
    return index;
  }

  if (raw.length === 0) return index;

  const fragments = raw.split('\n');
  const trailing = fragments[fragments.length - 1];
  // Well-formed jsonl ends with a newline → trailing is ''. Anything else is
  // an incomplete final line (mid-write crash, disk full).
  if (trailing !== '') {
    console.warn(
      `[rename-log] WARN: trailing line missing newline (${trailing.length} bytes); dropped`,
    );
  }
  const lines = fragments.slice(0, -1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (parseErr) {
      const sample = line.slice(0, 80);
      const errMsg = (parseErr as Error).message;
      console.warn(
        `[rename-log] WARN: corrupt entry at line ${i + 1} skipped (${errMsg}): ${sample}${line.length > 80 ? '…' : ''}`,
      );
      continue;
    }
    const entry = validateEntry(parsed);
    if (!entry) {
      console.warn(`[rename-log] WARN: corrupt entry at line ${i + 1} skipped`);
      continue;
    }
    indexInsert(index, entry);
  }

  if (index.byTo.size > 0) {
    liveEntriesGauge().add(index.byTo.size);
  }
  return index;
}

/**
 * Append one entry to `<shadow.gitDir>/renames.jsonl` and update the in-memory
 * index in lockstep. The shadow git dir is expected to exist; callers MUST
 * ensure it (boot creates `.git/ok/`).
 *
 * Validates schema before write — a malformed entry is rejected with a thrown
 * error so the rewrite spine's recovery envelope can roll back.
 *
 * **Hard-cap behavior.** When the file already exceeds `RENAME_LOG_HARD_CAP_BYTES`,
 * the caller may pass `shadow` so this helper schedules a deduped, fire-and-forget
 * `gcRenameLog(shadow, index)` AFTER the append succeeds. Without `shadow`
 * (e.g., unit tests that have only a directory path), only the warning fires —
 * the next saveVersion / boot / shadow-branch-gc cycle catches the runaway.
 *
 * The append itself is sync to preserve POSIX O_APPEND atomicity (single-server
 * deployment relies on the server lock for concurrency, but the kernel-level
 * atomicity guard means a future multi-writer lift won't reopen this question).
 */
export function appendRenameLogEntry(
  shadowDir: string,
  entry: RenameLogEntry,
  index: RenameLogIndex,
  shadow?: ShadowHandle,
): void {
  const validated = validateEntry(entry);
  if (!validated) {
    throw new Error('[rename-log] refusing to append malformed entry');
  }
  const serialized = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(serialized, 'utf-8') > RENAME_LOG_MAX_LINE_BYTES) {
    throw new Error(
      `[rename-log] entry exceeds max line size (${RENAME_LOG_MAX_LINE_BYTES} bytes)`,
    );
  }
  const path = renameLogPath(shadowDir);
  let overCap = false;
  if (existsSync(path)) {
    try {
      const size = statSync(path).size;
      if (size > RENAME_LOG_HARD_CAP_BYTES) {
        overCap = true;
        console.warn(
          `[rename-log] WARN: file size ${size} exceeds hard cap ${RENAME_LOG_HARD_CAP_BYTES}; forcing GC sweep`,
        );
      }
    } catch {
      // statSync failure here is non-fatal — keep the append flow going.
    }
  }
  tracedAppendFileSync(path, serialized, { flag: 'a' });
  indexInsert(index, validated);
  liveEntriesGauge().add(1);

  if (overCap && shadow) {
    scheduleHardCapGc(shadow, index);
  }
}

/**
 * Module-level dedup set: serializes all GC passes per gitDir. A pass running
 * here suppresses every concurrent trigger site (hard-cap microtask, post
 * saveVersion, shadow-branch-gc) until it finishes — `gcRenameLog` mutates
 * the shared index in place, so an interleaved second pass could observe a
 * stale snapshot of liveShas while the first pass's deletions are mid-flight
 * and atomically rewrite the jsonl with that stale view. The set is keyed by
 * gitDir because in a multi-shadow-handle test environment two shadows may
 * overlap.
 */
const gcPending: Set<string> = new Set();

function scheduleHardCapGc(shadow: ShadowHandle, index: RenameLogIndex): void {
  // Microtask gives us a clean stack frame so the post-condition that the
  // append has been observed by readers holds before GC mutates the index.
  // gcRenameLog itself enforces the gitDir-scoped dedup invariant.
  queueMicrotask(() => {
    gcRenameLog(shadow, index).catch((err) => {
      console.warn('[rename-log] WARN: hard-cap forced GC failed:', err);
    });
  });
}

/**
 * Module-level cache: single-server deployment has at most one shadowDir
 * live at a time, so the cache holds a single entry. Boot wires
 * `setRenameLogIndex` to swap in the loaded index; lazy fallback via
 * `getOrLoadRenameLogIndex` makes the read path resilient to a missed
 * boot wiring (e.g., tests that skip server bring-up).
 *
 * Tests that mutate state should call `resetRenameLogIndexCache()` in
 * `afterEach` to keep test isolation.
 */
let _moduleIndex: { shadowDir: string; index: RenameLogIndex } | null = null;

export function setRenameLogIndex(shadowDir: string, index: RenameLogIndex): void {
  _moduleIndex = { shadowDir, index };
}

export function getOrLoadRenameLogIndex(shadowDir: string): RenameLogIndex {
  if (_moduleIndex && _moduleIndex.shadowDir === shadowDir) return _moduleIndex.index;
  const index = loadRenameLogIndex(shadowDir);
  _moduleIndex = { shadowDir, index };
  return index;
}

export function resetRenameLogIndexCache(): void {
  _moduleIndex = null;
}

/**
 * Test/internal helper: rewrite the entire jsonl file atomically (tmp +
 * rename). Used by the GC pass and by the lazy-population backfill. Lives
 * in this module so the rename-log file format stays a single-source-of-truth.
 *
 * Caller is responsible for updating the in-memory index to match.
 */
export function serializeIndexToString(index: RenameLogIndex): string {
  const lines: string[] = [];
  // Iterate `byTo` because `byFrom` may carry duplicates (same `from`
  // pointing at multiple later renames).
  for (const entry of index.byTo.values()) {
    lines.push(JSON.stringify(entry));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// ─── Read primitives (chain walker + cycle bound + batched probe stream) ───

/**
 * Resolve the per-call git timeout. Reads `OK_GIT_TIMEOUT_MS` on every
 * invocation rather than caching at module load — tests rely on dynamic
 * override (set env, then call). Default 30s; invalid / non-positive values
 * fall back to the default.
 */
function parseGitTimeoutMs(): number {
  const raw = process.env.OK_GIT_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

/**
 * One step in the predecessor chain. `path` is the docName at that point in
 * the chain; `renameCommit` is the SHA of the rename commit that turned
 * `path` into the next step's name. The trailing element (current docName)
 * has `renameCommit: null` (unbounded — current name is always live).
 *
 * Entries with empty `commitSha` log records are SKIPPED upstream and DO
 * NOT appear here (lazy-population window — chain truncates until backfill).
 */
interface PredecessorChainEntry {
  path: string;
  renameCommit: string | null;
}

/**
 * Hard upper bound on predecessor chain depth. Prevents pathological inputs
 * (long linear chains that pass cycle detection) from spawning unbounded git
 * subprocesses on the read path. Realistic chain
 * depth is ≤ 50; this cap leaves generous headroom while bounding worst-case
 * timeline latency to N×OK_GIT_TIMEOUT_MS.
 */
export const MAX_PREDECESSOR_CHAIN_DEPTH = 100;

interface PredecessorChainResult {
  chain: PredecessorChainEntry[];
  /** Count of empty-commitSha entries observed during the walk. */
  skipped: number;
}

/**
 * Walk the rename chain backward from `currentDocName` (following `byTo`) and
 * return predecessors in oldest→newest order, with the current docName
 * trailing as `{ path: currentDocName, renameCommit: null }`. Cycle-guarded —
 * a corrupted self-cycle terminates with a warning instead of looping.
 * Entries with empty `commitSha` truncate the chain at that point.
 *
 * Returns `{ chain: [{path: currentDocName, renameCommit: null}], skipped: 0 }`
 * for an un-renamed doc — chain shape is identical to today's no-rename-history
 * case so consumers don't branch.
 *
 * `skipped` counts empty-commitSha entries the walk truncated at; consumers
 * use it to drive the lazy-population observability counter.
 */
export function expandPredecessors(
  currentDocName: string,
  branch: string,
  index: RenameLogIndex,
): PredecessorChainResult {
  const chain: PredecessorChainEntry[] = [];
  const visited = new Set<string>();
  let cursor: string = currentDocName;
  let skipped = 0;
  // Build predecessors first, then append the current doc as the trailing
  // element. The newest→oldest walk uses byTo: each step asks "what was the
  // predecessor of `cursor`?" by looking up `index.byTo.get(cursor)`.
  while (true) {
    if (chain.length >= MAX_PREDECESSOR_CHAIN_DEPTH) {
      console.warn(
        `[rename-log] WARN: predecessor chain depth exceeded ${MAX_PREDECESSOR_CHAIN_DEPTH} while expanding "${currentDocName}"; truncating`,
      );
      break;
    }
    if (visited.has(cursor)) {
      console.warn(
        `[rename-log] WARN: cycle detected at "${cursor}" while expanding predecessors of "${currentDocName}"; truncating`,
      );
      break;
    }
    visited.add(cursor);
    const entry = index.byTo.get(cursor);
    if (!entry) break;
    if (entry.branch !== branch) break;
    if (entry.commitSha === '') {
      skipped += 1;
      break;
    }
    chain.push({ path: entry.from, renameCommit: entry.commitSha });
    cursor = entry.from;
  }
  // The loop above builds predecessors newest→oldest (each step asks "what
  // was the predecessor of `cursor`?" via byTo). Reverse to put the oldest
  // predecessor at index [0]; consumers iterate backward from chain.length-1
  // to walk newest-first.
  chain.reverse();
  chain.push({ path: currentDocName, renameCommit: null });
  return { chain, skipped };
}

/**
 * Per-request memo for `buildAncestorShaSet`. Caller passes a fresh `Map`
 * per HTTP request; key shape is `branch + ':' + sortedSeeds.join(',')`.
 */
export type AncestorShaSetCache = Map<string, Set<string>>;

export function createAncestorShaSetCache(): AncestorShaSetCache {
  return new Map();
}

/**
 * Per-request memo for `buildSeeds`. Same shape as `AncestorShaSetCache` —
 * within one HTTP request, `getDocumentHistory`'s checkpoint filter and WIP
 * predecessor walk both call `buildSeeds` for every predecessor step. Sharing
 * the cache halves the `git show` + `for-each-ref` subprocess spawns per
 * request when both code paths run.
 */
export type SeedsCache = Map<string, string[]>;

export function createSeedsCache(): SeedsCache {
  return new Map();
}

/**
 * Returns `seeds(R) = {R} ∪ {K : K.creator_date < R.author_date}` for a
 * given rename commit on `branch`. Strict less-than excludes same-second
 * checkpoints — single-server deployment has no clock skew, so the
 * strict-less-than precision is sufficient.
 *
 * Reads:
 *   git for-each-ref --sort=-creatordate \
 *     --format='%(creatordate:iso8601-strict) %(objectname)' \
 *     refs/checkpoints/<branch>/
 *   git show -s --format=%aI <renameCommit>
 */
export async function buildSeeds(
  shadow: ShadowHandle,
  renameCommit: string,
  branch: string,
  cache?: SeedsCache,
): Promise<string[]> {
  return withSpan('rename.buildSeeds', undefined, async (span) => {
    if (cache) {
      const hit = cache.get(`${branch}:${renameCommit}`);
      if (hit) {
        span.setAttribute('rename.seeds_count', hit.length);
        span.setAttribute('rename.cache_hit', true);
        return hit;
      }
    }

    const sg = shadowGit(shadow);

    let renameAuthorDate: string;
    try {
      renameAuthorDate = (await sg.raw('show', '-s', '--format=%aI', renameCommit)).trim();
    } catch (err) {
      console.warn(
        `[rename-log] WARN: buildSeeds: git show failed for rename commit ${renameCommit}; falling back to single-seed:`,
        err,
      );
      span.setAttribute('rename.seeds_count', 1);
      return [renameCommit];
    }
    if (!renameAuthorDate) {
      span.setAttribute('rename.seeds_count', 1);
      return [renameCommit];
    }

    let raw: string;
    try {
      raw = await sg.raw(
        'for-each-ref',
        '--sort=-creatordate',
        '--format=%(creatordate:iso8601-strict) %(objectname)',
        `refs/checkpoints/${branch}/`,
      );
    } catch (err) {
      console.warn(
        `[rename-log] WARN: buildSeeds: for-each-ref failed for branch ${branch}; falling back to single-seed:`,
        err,
      );
      span.setAttribute('rename.seeds_count', 1);
      return [renameCommit];
    }

    const seeds: string[] = [renameCommit];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.lastIndexOf(' ');
      if (spaceIdx < 0) continue;
      const date = trimmed.slice(0, spaceIdx);
      const sha = trimmed.slice(spaceIdx + 1);
      if (sha.length !== 40) continue;
      if (sha === renameCommit) continue; // R is already the seed; skip duplicate
      if (date < renameAuthorDate) seeds.push(sha);
    }
    span.setAttribute('rename.seeds_count', seeds.length);
    if (cache) cache.set(`${branch}:${renameCommit}`, seeds);
    return seeds;
  });
}

/**
 * Approximate per-byte threshold above which a seed/ref list should be sent
 * via stdin instead of as command-line args. POSIX `ARG_MAX` is at least
 * 32 KB on every supported OS; macOS is ~256 KB, Linux is typically much
 * higher. We pick 100 KB to leave ample headroom for environment variables
 * and other arguments while keeping the fast path for typical small lists.
 */
const REV_LIST_STDIN_THRESHOLD_BYTES = 100 * 1024;
const GIT_STDIN_STDIO_OPTIONS: { stdio: ['pipe', 'pipe', 'pipe'] } = {
  stdio: ['pipe', 'pipe', 'pipe'],
};
const GIT_BATCH_CHECK_STDIO_OPTIONS: { stdio: ['pipe', 'pipe', 'ignore'] } = {
  stdio: ['pipe', 'pipe', 'ignore'],
};

/**
 * Run `git rev-list <refs>` over an arbitrary-size ref list. Falls through
 * to `simple-git`'s `raw('rev-list', ...refs)` for small inputs, but pipes
 * via stdin (`git rev-list --stdin`) when the joined refs exceed the
 * arg-byte threshold — a long-lived project with thousands of checkpoints
 * would otherwise hit `E2BIG` on `execve(2)` and the failure mode is silent
 * (caller catches and returns empty set, dropping history).
 */
async function revListReachable(shadow: ShadowHandle, refs: string[]): Promise<string> {
  if (refs.length === 0) return '';
  const argBytes = refs.reduce((acc, r) => acc + r.length + 1, 0);
  if (argBytes < REV_LIST_STDIN_THRESHOLD_BYTES) {
    return shadowGit(shadow).raw('rev-list', ...refs);
  }
  const timeoutMs = parseGitTimeoutMs();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'git',
      ['rev-list', '--stdin'],
      withHiddenWindowsConsole({
        ...GIT_STDIN_STDIO_OPTIONS,
        env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      }),
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // child may already be dead
      }
      rejectPromise(new Error(`git rev-list --stdin timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        rejectPromise(new Error(`git rev-list --stdin exited ${code}: ${stderr}`));
        return;
      }
      resolvePromise(Buffer.concat(stdoutChunks).toString('utf-8'));
    });
    try {
      child.stdin.end(`${refs.join('\n')}\n`);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err as Error);
    }
  });
}

/**
 * Run `git log <flags> <seeds> -- <pathspec>` over an arbitrary-size seed
 * list. Mirrors `revListReachable`: small seed lists go through `simple-git`'s
 * argv path (fast); large lists pipe seeds via stdin (`git log --stdin`) so
 * the timeline predecessor walk can't hit `E2BIG` on long-lived projects with
 * thousands of checkpoints.
 *
 * `--` is appended after seeds when `pathspec` is non-empty so git
 * disambiguates revs from paths. Pathspecs themselves are kept on argv —
 * stdin is rev-only.
 */
export async function logSeededReachable(
  shadow: ShadowHandle,
  flags: string[],
  seeds: string[],
  pathspec: string | undefined,
): Promise<string> {
  if (seeds.length === 0) return '';
  const argBytes = seeds.reduce((acc, s) => acc + s.length + 1, 0);
  if (argBytes < REV_LIST_STDIN_THRESHOLD_BYTES) {
    const args = [...flags, ...seeds, ...(pathspec ? ['--', pathspec] : [])];
    return shadowGit(shadow).raw('log', ...args);
  }
  const timeoutMs = parseGitTimeoutMs();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    // `git log --stdin` reads revs from stdin (one per line) and pathspecs
    // from argv after `--`. Combining stdin + argv pathspec is documented
    // and stable across git versions.
    const args = ['log', '--stdin', ...flags, ...(pathspec ? ['--', pathspec] : [])];
    const child = spawn(
      'git',
      args,
      withHiddenWindowsConsole({
        ...GIT_STDIN_STDIO_OPTIONS,
        env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      }),
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // child may already be dead
      }
      rejectPromise(new Error(`git log --stdin timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        rejectPromise(new Error(`git log --stdin exited ${code}: ${stderr}`));
        return;
      }
      resolvePromise(Buffer.concat(stdoutChunks).toString('utf-8'));
    });
    try {
      child.stdin.end(`${seeds.join('\n')}\n`);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err as Error);
    }
  });
}

/**
 * `git rev-list <seeds>` once → Set<sha> for O(1) membership. Empty seeds
 * → empty set. Cache lookup keyed by `branch + ':' + sortedSeeds.join(',')`
 * — caller is responsible for branch-scoping (seeds always resolve through
 * branch-scoped checkpoint refs upstream, so passing the branch ensures
 * cache disambiguation when multiple branches share a Map instance).
 *
 * Routes through `revListReachable` so seed lists exceeding the safe
 * argv-byte threshold pipe via stdin instead of failing with `E2BIG`.
 */
export async function buildAncestorShaSet(
  shadow: ShadowHandle,
  seeds: string[],
  branch: string,
  cache?: AncestorShaSetCache,
): Promise<Set<string>> {
  return withSpan('rename.buildAncestorShaSet', undefined, async (span) => {
    if (seeds.length === 0) {
      span.setAttribute('rename.ancestor_shas_count', 0);
      return new Set();
    }
    const cacheKey = `${branch}:${[...seeds].sort().join(',')}`;
    if (cache) {
      const hit = cache.get(cacheKey);
      if (hit) {
        span.setAttribute('rename.ancestor_shas_count', hit.size);
        span.setAttribute('rename.cache_hit', true);
        return hit;
      }
    }

    let raw: string;
    try {
      raw = await revListReachable(shadow, seeds);
    } catch (err) {
      console.warn(
        `[rename-log] WARN: buildAncestorShaSet: rev-list failed (${seeds.length} seeds); falling back to empty set:`,
        err,
      );
      span.setAttribute('rename.ancestor_shas_count', 0);
      return new Set();
    }

    const set = new Set<string>();
    for (const line of raw.split('\n')) {
      const sha = line.trim();
      if (sha.length === 40) set.add(sha);
    }
    if (cache) cache.set(cacheKey, set);
    span.setAttribute('rename.ancestor_shas_count', set.size);
    return set;
  });
}

/**
 * One-shot batched `git cat-file --batch-check` stream over `(sha, path)`
 * probes. Spawns ONE child process per call; writes all probes via stdin
 * (`<sha>:<path>\n` per line); parses stdout in order matching probe order.
 * Returns `boolean[]` aligned with `probes` — `true` when the path exists
 * in the commit's tree, `false` otherwise (missing object → `<sha>:<path>
 * missing` response per `git cat-file --batch-check` protocol).
 *
 * Wraps in `OK_GIT_TIMEOUT_MS` — on timeout the entire batch resolves with
 * `false` for every probe and a warning is logged.
 */
export function batchCheckExistence(
  shadow: ShadowHandle,
  probes: Array<{ sha: string; path: string }>,
): Promise<boolean[]> {
  if (probes.length === 0) return Promise.resolve([]);

  const timeoutMs = parseGitTimeoutMs();

  return new Promise<boolean[]>((resolvePromise) => {
    // stderr is `'ignore'` (kernel-level discard) rather than `'pipe'`. A
    // piped stderr that is never read can fill the OS pipe buffer (~64 KB
    // typical) and block the child until the timeout fires — git can write
    // diagnostic messages to stderr under repository corruption or
    // concurrent gc, both of which are realistic failure modes here.
    const child = spawn(
      'git',
      ['cat-file', '--batch-check', '--buffer'],
      withHiddenWindowsConsole({
        ...GIT_BATCH_CHECK_STDIO_OPTIONS,
        env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      }),
    );

    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

    const allFalse = (): boolean[] => probes.map(() => false);

    let settled = false;
    const settle = (result: boolean[]) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      console.warn(
        `[rename-log] WARN: batchCheckExistence timed out after ${timeoutMs}ms (${probes.length} probes); returning all-false`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // child may already be dead
      }
      settle(allFalse());
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`[rename-log] WARN: batchCheckExistence spawn error: ${err.message}`);
      settle(allFalse());
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Treat any non-zero exit (or signal-kill we didn't issue ourselves) as
      // batch failure. The `missing` response is git's normal protocol for an
      // unknown object — a true failure is the process exiting non-zero
      // (corrupted repo, GIT_DIR misconfiguration, OOM). Returning all-false
      // here is the safe choice: a false negative means we keep an entry that
      // might be safe to drop (rare), while a false positive (treating a
      // crashed batch as "all missing") would silently drop live entries.
      if ((code !== null && code !== 0) || (signal && !settled)) {
        console.warn(
          `[rename-log] WARN: batchCheckExistence exited code=${code} signal=${signal ?? 'none'}; returning all-false`,
        );
        settle(allFalse());
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const lines = stdout.split('\n').filter((l) => l.length > 0);
      // Each input line `<sha>:<path>` produces one output line:
      //   missing: `<sha>:<path> missing`
      //   present: `<sha>:<path> <hash> <type> <size>`
      // Output order matches input order (per git docs). Map line→bool.
      const result: boolean[] = probes.map((_, i) => {
        const line = lines[i];
        if (!line) return false;
        return !line.endsWith(' missing');
      });
      settle(result);
    });

    const stdin = probes.map((p) => `${p.sha}:${p.path}`).join('\n');
    try {
      child.stdin.end(`${stdin}\n`);
    } catch (err) {
      clearTimeout(timer);
      console.warn(
        `[rename-log] WARN: batchCheckExistence stdin write failed: ${(err as Error).message}`,
      );
      settle(allFalse());
    }
  });
}

/**
 * Atomically rewrite `<shadowDir>/renames.jsonl` from the in-memory index.
 * tmp+rename for POSIX atomicity. Empty index → file is truncated to zero
 * bytes (next load returns the empty index). Server lock guarantees no
 * concurrent writers.
 */
function rewriteJsonlAtomically(shadowDir: string, index: RenameLogIndex): void {
  const path = renameLogPath(shadowDir);
  const serialized = serializeIndexToString(index);
  if (serialized.length === 0) {
    if (existsSync(path)) {
      try {
        tracedWriteFileSync(path, '');
      } catch (err) {
        console.warn('[rename-log] WARN: failed to truncate empty jsonl:', err);
      }
    }
    return;
  }
  // Tmp+rename: tmp write may fail (ENOSPC, EROFS) and the rename may fail
  // (cross-device, missing parent dir). Either path leaves the in-memory index
  // ahead of disk — the next backfill or GC will retry on its own write.
  // Throwing here would propagate up to a caller mid-rename and abort the
  // rewrite spine, leaving the journal in an inconsistent state. Warn and
  // return so the on-disk jsonl converges on the next successful write.
  const tmp = `${path}.tmp`;
  try {
    tracedWriteFileSync(tmp, serialized);
    tracedRenameSync(tmp, path);
  } catch (err) {
    console.warn('[rename-log] WARN: atomic rewrite failed; index ahead of disk:', err);
    // Best-effort cleanup of the orphaned tmp file. If this throws too, the
    // next rewrite will overwrite it.
    try {
      if (existsSync(tmp)) tracedUnlinkSync(tmp);
    } catch {
      // tmp may already be gone or unlink may race with another writer
    }
  }
}

/**
 * Backfill `commitSha` on entries that are in the lazy-population window
 * window. Scans the in-memory index for entries with `commitSha: ''` AND
 * `actor.writerId === writerId`; sets them to the freshly-committed
 * `commitSha` and atomically rewrites the jsonl.
 *
 * Returns the count of entries updated. Idempotent — calling with no
 * pending entries is a no-op.
 */
export function backfillRenameLogCommitSha(
  shadowDir: string,
  writerId: string,
  commitSha: string,
  index: RenameLogIndex,
): { updated: number } {
  // Module-boundary guard. A bogus SHA written here would transition entries
  // out of the recoverable empty-commitSha state into a permanently broken
  // one: `sweepLazyPopOrphans` would no longer match (commitSha non-empty)
  // and reachability GC would silently drop them as unreachable.
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    console.warn(
      `[rename-log] WARN: backfill rejected invalid commitSha: ${JSON.stringify(commitSha)}`,
    );
    return { updated: 0 };
  }
  let updated = 0;
  for (const entry of index.byTo.values()) {
    if (entry.commitSha !== '') continue;
    if (entry.actor.writerId !== writerId) continue;
    entry.commitSha = commitSha;
    updated += 1;
  }
  if (updated > 0) rewriteJsonlAtomically(shadowDir, index);
  return { updated };
}

/**
 * Boot-time orphan cleanup for the lazy-population window. ANY entry with
 * empty `commitSha` at boot is provably an orphan from a mid-rename crash —
 * no in-flight rename can exist at server startup (server lock guarantees
 * single-writer; no in-memory state survives a process restart). Drops
 * those entries and atomically rewrites the jsonl.
 *
 * Returns the count of entries dropped. Idempotent — boots after a clean
 * shutdown drop nothing.
 *
 * Recovery chain (boot order):
 *   1. `loadRenameLogIndex` — parse jsonl into byTo/byFrom maps;
 *   2. `sweepLazyPopOrphans` (this) — drop in-flight entries left behind
 *      by a crash inside the rewrite-spine recovery envelope (between
 *      `appendRenameLogEntry` and `backfillRenameLogCommitSha`);
 *   3. `setRenameLogIndex` — publish to the per-shadowDir cache;
 *   4. `gcRenameLog({rebuild: true})` — reachability-based GC + rebuild
 *      from `OkActorEntry.previous_paths` lines on `rename:` commits.
 *
 * Sequencing matters: GC's reachability walk treats empty-commitSha entries
 * as in-flight (skipped), so without this sweep the log would carry orphans
 * indefinitely until the next rename's append happens to re-populate them.
 *
 * Wired in `server-factory.ts` boot sequence.
 */
export function sweepLazyPopOrphans(shadowDir: string, index: RenameLogIndex): { dropped: number } {
  const orphans: RenameLogEntry[] = [];
  for (const entry of index.byTo.values()) {
    if (entry.commitSha === '') orphans.push(entry);
  }
  if (orphans.length === 0) return { dropped: 0 };
  for (const orphan of orphans) {
    indexRemove(index, orphan);
  }
  rewriteJsonlAtomically(shadowDir, index);
  liveEntriesGauge().add(-orphans.length);
  console.warn(
    `[rename-log] gc swept ${orphans.length} orphan entries (lazy-pop residue from mid-rename crash)`,
  );
  return { dropped: orphans.length };
}

/**
 * Reachability-based GC for the rename log.
 *
 * Walks `refs/wip/<branch>/* ∪ refs/checkpoints/<branch>/*` for ALL
 * branches, runs one `git rev-list <refs>` to build the live SHA set,
 * then drops entries whose `commitSha` is not reachable. Park-tipped refs
 * are reachable, so any commit reachable from a `refs/wip/*` or
 * `refs/checkpoints/*` ref is "live" regardless of TIP subject — the
 * reachability check is purely structural.
 *
 * Empty-`commitSha` entries are PRESERVED here. They represent in-flight
 * lazy-population state — a rename whose backfill drain has not yet
 * fired. Boot-time runs must call `sweepLazyPopOrphans` first to drop
 * mid-rename-crash residue (single-server invariant: no in-flight rename
 * can exist at startup); runtime invocations leave them alone so the
 * post-rename drain can still close the window.
 *
 * On boot, also walks shadow rename commits via `git log --all --grep
 * '^rename: '` and reconstructs missing entries from
 * `OkActorEntry.previous_paths`. All reconstructed entries from the same
 * rename commit share a single deterministic `groupId` derived from the
 * commit SHA — a folder rename of N docs produces N entries with one shared
 * groupId, mirroring the runtime invariant.
 *
 * Returns `{ scanned, dropped, retained, rebuilt }`. Atomic rewrite via
 * `rewriteJsonlAtomically` runs once at the end if anything changed.
 */
interface RenameLogGcResult {
  scanned: number;
  dropped: number;
  retained: number;
  rebuilt: number;
}

export async function gcRenameLog(
  shadow: ShadowHandle,
  index: RenameLogIndex,
  options?: { rebuild?: boolean },
): Promise<RenameLogGcResult> {
  const result: RenameLogGcResult = { scanned: 0, dropped: 0, retained: 0, rebuilt: 0 };

  // Serialize all GC passes per gitDir. gcRenameLog yields at every
  // `await sg.raw(...)`, so two overlapping invocations can interleave
  // mutations on the shared index. The single-server invariant means there
  // is never legitimate contention — skipping the second invocation is
  // always safe; the first pass's reachability set is at least as fresh.
  if (gcPending.has(shadow.gitDir)) {
    return result;
  }
  gcPending.add(shadow.gitDir);
  try {
    return await gcRenameLogInner(shadow, index, options, result);
  } finally {
    gcPending.delete(shadow.gitDir);
  }
}

async function gcRenameLogInner(
  shadow: ShadowHandle,
  index: RenameLogIndex,
  options: { rebuild?: boolean } | undefined,
  result: RenameLogGcResult,
): Promise<RenameLogGcResult> {
  const sg = shadowGit(shadow);

  // Snapshot BEFORE any await. The hazard: while GC is awaiting `for-each-ref`
  // and `rev-list`, a concurrent `backfillRenameLogCommitSha` may mutate
  // `entry.commitSha` from '' to a real sha (or rewrite an existing sha during
  // a fixup), or `appendRenameLogEntry` may displace `byTo` mappings. Reading
  // `entry.commitSha` after the await would give us a value that wasn't
  // checked against `liveShas` — and dropping based on a stale liveness check
  // would corrupt the log. Snapshot captures `(entry, observedSha)` pairs at
  // the start; we re-validate identity AND commitSha-unchanged before dropping.
  //
  // `result.scanned` is set AFTER the await pair succeeds — pre-await abort
  // cases (for-each-ref / rev-list throw) report `scanned: 0` to signal
  // "bailed before any reachability work" so callers can distinguish a clean
  // transient-error skip from a no-op pass with no candidates.
  const candidates: Array<{ entry: RenameLogEntry; observedSha: string }> = [];
  for (const entry of index.byTo.values()) {
    // Empty commitSha is in-flight lazy-pop state — `sweepLazyPopOrphans`
    // (boot-only) is the only sanctioned place to drop these.
    if (entry.commitSha === '') continue;
    candidates.push({ entry, observedSha: entry.commitSha });
  }

  // Distinguish "no refs exist" (genuine empty output → proceed; nothing to
  // keep alive, drop unreachable entries as designed) from "ref enumeration
  // failed" (thrown error → abort; treating it as 'no refs' would wipe every
  // live entry and atomically rewrite the jsonl with nothing). Same shape
  // applies to rev-list — empty seeds shortcut never throws; a thrown error
  // means we can't trust the liveness set.
  let refLines: string[];
  try {
    refLines = (
      await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/', 'refs/checkpoints/')
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    console.warn('[rename-log] WARN: gcRenameLog aborted — failed to enumerate refs:', err);
    return result;
  }

  const liveShas: Set<string> = new Set();
  if (refLines.length > 0) {
    let raw: string;
    try {
      raw = await revListReachable(shadow, refLines);
    } catch (err) {
      console.warn('[rename-log] WARN: gcRenameLog aborted — rev-list failed:', err);
      return result;
    }
    for (const line of raw.split('\n')) {
      const sha = line.trim();
      if (sha.length === 40) liveShas.add(sha);
    }
  }

  // Reachability work succeeded — record the scan count now that we're past
  // the abort points.
  const beforeCount = index.byTo.size;
  result.scanned = beforeCount;

  const toDrop: RenameLogEntry[] = [];
  for (const { entry, observedSha } of candidates) {
    if (liveShas.has(observedSha)) continue;
    // Re-validate identity (entry not displaced by a concurrent append) AND
    // commitSha unchanged (not backfilled to a sha that may now be live).
    // If either changed, the entry is no longer the one we observed and our
    // liveness check doesn't apply to it.
    const current = index.byTo.get(entry.to);
    if (current === entry && entry.commitSha === observedSha) {
      toDrop.push(entry);
    }
  }

  for (const entry of toDrop) {
    // Final identity check immediately before mutation closes the
    // observed→commit window further. Cheap: O(1) Map.get.
    if (index.byTo.get(entry.to) === entry) {
      indexRemove(index, entry);
    }
  }
  result.dropped = toDrop.length;
  result.retained = index.byTo.size;

  if (options?.rebuild) {
    let logRaw: string;
    try {
      logRaw = await sg.raw('log', '--all', '--grep=^rename: ', '--format=%H%x00%cI%x00%B%x1e');
    } catch (err) {
      // Silent failure here was indistinguishable from "no rename commits
      // found" — rebuild is the recovery path for a corrupt or missing
      // jsonl, so an unobservable failure of the recovery itself is the
      // worst-case shape. Warn so the operator sees that rebuild was
      // attempted but git rejected it.
      console.warn(
        '[rename-log] WARN: gcRenameLog rebuild: git log --grep failed; skipping reconstruction:',
        err,
      );
      logRaw = '';
    }

    // Pre-build per-branch reachability maps ONCE so the rebuild loop
    // becomes O(B) lookups instead of N × `for-each-ref --contains` (each of
    // which spawns a subprocess and walks the DAG from every ref). Avoids
    // the multi-minute boot delays a project with hundreds of historical
    // rename commits would otherwise incur.
    const branchReachability = await buildBranchReachabilityMap(shadow, refLines);

    for (const record of logRaw.split('\x1e')) {
      const trimmed = record.trimStart();
      if (!trimmed) continue;
      const parts = trimmed.split('\x00');
      const sha = (parts[0] ?? '').trim();
      const committerDate = (parts[1] ?? '').trim();
      const body = parts[2] ?? '';
      if (sha.length !== 40) continue;
      if (!liveShas.has(sha)) continue;
      const actors = parseOkActors(body);

      // A folder-rename produces N `previous_paths` entries on a single
      // commit (often spread across multiple OkActorEntry lines when the
      // drain crossed multiple writers). A file-rename produces exactly
      // one. Counting across actors disambiguates: >1 → 'folder', 1 →
      // 'file'. Caller-side `recordContributor` enforces this on the
      // write side; the rebuild path mirrors it.
      let totalPairs = 0;
      for (const actor of actors) {
        totalPairs += actor.previous_paths?.length ?? 0;
      }
      if (totalPairs === 0) continue;
      const kind: 'file' | 'folder' = totalPairs > 1 ? 'folder' : 'file';

      const branchFromRefs = lookupBranchInMap(branchReachability, sha);
      // Reconstructed entries share a deterministic groupId across the
      // whole commit so a folder-rename's siblings stay grouped (matches
      // the runtime invariant that one outer rewrite-spine call → one
      // groupId for all affectedDocs).
      const groupId = deriveGroupId(sha, '', '');

      for (const actor of actors) {
        if (!actor.previous_paths || actor.previous_paths.length === 0) continue;
        for (const pair of actor.previous_paths) {
          if (index.byTo.has(pair.to)) continue;
          const reconstructed: RenameLogEntry = {
            v: 1,
            from: pair.from,
            to: pair.to,
            at: committerDate || new Date(0).toISOString(),
            commitSha: sha,
            branch: branchFromRefs,
            groupId,
            kind,
            actor: { writerId: actor.writer_id, displayName: actor.display_name },
          };
          indexInsert(index, reconstructed);
          result.rebuilt += 1;
          result.retained += 1;
        }
      }
    }
  }

  if (result.dropped > 0 || result.rebuilt > 0) {
    rewriteJsonlAtomically(shadow.gitDir, index);
  }

  if (result.dropped > 0) {
    console.warn(
      `[rename-log] gc swept ${result.dropped} dead entries (${result.retained} live remain)`,
    );
    gcDroppedCounter().add(result.dropped);
    liveEntriesGauge().add(-result.dropped);
  }
  if (result.rebuilt > 0) {
    liveEntriesGauge().add(result.rebuilt);
  }

  return result;
}

function deriveGroupId(sha: string, from: string, to: string): string {
  const hash = createHash('sha256');
  hash.update(`${sha}\0${from}\0${to}`);
  const hex = hash.digest('hex');
  // Format as UUID-like 8-4-4-4-12 for consistency with appended entries.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Build `Map<branch, Set<sha>>` from the already-enumerated WIP/checkpoint
 * refs by grouping refs by branch slug, then running one `git rev-list` per
 * branch (via the stdin-safe helper). Branches whose rev-list fails are
 * dropped from the map — affected commits fall back to `'main'` via
 * `lookupBranchInMap`. Iteration order matches insertion order (sorted ref
 * names) so repeated boots produce deterministic branch attribution for
 * commits reachable from multiple branches.
 */
async function buildBranchReachabilityMap(
  shadow: ShadowHandle,
  refLines: string[],
): Promise<Map<string, Set<string>>> {
  const branchRefs = new Map<string, string[]>();
  for (const ref of [...refLines].sort()) {
    // Patterns: refs/wip/<branch>/<writerId>  |  refs/checkpoints/<branch>/<sha>
    const m = /^refs\/(?:wip|checkpoints)\/([^/]+)\//.exec(ref);
    if (!m?.[1]) continue;
    const bucket = branchRefs.get(m[1]) ?? [];
    bucket.push(ref);
    branchRefs.set(m[1], bucket);
  }
  const map = new Map<string, Set<string>>();
  for (const [branch, refs] of branchRefs) {
    let raw: string;
    try {
      raw = await revListReachable(shadow, refs);
    } catch (err) {
      console.warn(
        `[rename-log] WARN: gcRenameLog rebuild: rev-list failed for branch ${branch}; reconstructed entries on this branch will fall back to 'main':`,
        err,
      );
      continue;
    }
    const set = new Set<string>();
    for (const line of raw.split('\n')) {
      const sha = line.trim();
      if (sha.length === 40) set.add(sha);
    }
    map.set(branch, set);
  }
  return map;
}

/**
 * Look up the first branch in `map` whose reachability set contains `sha`.
 * Insertion order matches sorted ref enumeration, so multi-branch commits
 * resolve deterministically across boots. Falls back to `'main'` when no
 * branch claims the commit — defensive: the caller already filtered by
 * `liveShas`, so reaching the fallback means the per-branch rev-list set
 * was incomplete (e.g., a rev-list call failed and the branch was dropped
 * from the map).
 */
function lookupBranchInMap(map: Map<string, Set<string>>, sha: string): string {
  for (const [branch, shas] of map) {
    if (shas.has(sha)) return branch;
  }
  return 'main';
}

/**
 * Resolve the historical path of `currentDocName` at `commitSha`, scoped by
 * the cycle bound for each predecessor.
 *
 * Reachability work is parallelized across predecessors and all surviving
 * `(sha, path)` probes are amortized into a single `git cat-file
 * --batch-check` stream — matches the batched design intent in
 * `filterEntriesByChain`. First match in newest→oldest order wins. Returns
 * `null` when no historical path matches — caller decides whether to 404
 * or fall through.
 */
export async function resolveDocPathAtCommit(
  shadow: ShadowHandle,
  currentDocName: string,
  commitSha: string,
  branch: string,
  index: RenameLogIndex,
  pathFor: (docName: string) => string,
  cache?: AncestorShaSetCache,
  seedsCache?: SeedsCache,
): Promise<string | null> {
  const { chain } = expandPredecessors(currentDocName, branch, index);

  // Phase 1: parallelize cycle-bound work for predecessors. Current name
  // (renameCommit === null) needs no bound and contributes no work here.
  const predecessorAncestors: Array<Set<string> | null> = await Promise.all(
    chain.map(async (step) => {
      if (step.renameCommit === null) return null;
      const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
      if (seeds.length === 0) return new Set<string>();
      return buildAncestorShaSet(shadow, seeds, branch, cache);
    }),
  );

  // Phase 2: build the probe list in newest→oldest priority order, dropping
  // predecessor steps whose cycle bound rejects the target sha.
  const probes: Array<{ sha: string; path: string }> = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = chain[i];
    const ancestors = predecessorAncestors[i];
    if (ancestors !== null && !ancestors.has(commitSha)) continue;
    probes.push({ sha: commitSha, path: pathFor(step.path) });
  }

  if (probes.length === 0) return null;

  // Phase 3: one batch-check stream covers every surviving probe.
  const results = await batchCheckExistence(shadow, probes);

  // Phase 4: probes are already ordered newest→oldest, so first true wins.
  for (let i = 0; i < probes.length; i++) {
    if (results[i]) return probes[i].path;
  }
  return null;
}
