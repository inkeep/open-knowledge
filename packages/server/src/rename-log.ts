import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOkActors } from '@inkeep/open-knowledge-core/shadow-repo-layout';
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

export interface RenameLogEntry {
  v: 1;
  from: string;
  to: string;
  at: string;
  commitSha: string;
  branch: string;
  groupId: string;
  kind: 'file' | 'folder';
  actor: {
    writerId: string;
    displayName: string;
  };
}

export const RENAME_LOG_HARD_CAP_BYTES = 5 * 1024 * 1024;

const RENAME_LOG_MAX_LINE_BYTES = 4 * 1024;

const RENAME_LOG_FILENAME = 'renames.jsonl';

export interface RenameLogIndex {
  byTo: Map<string, RenameLogEntry>;
  byFrom: Map<string, RenameLogEntry[]>;
}

export function createEmptyIndex(): RenameLogIndex {
  return { byTo: new Map(), byFrom: new Map() };
}

export function renameLogPath(shadowDir: string): string {
  return resolve(shadowDir, RENAME_LOG_FILENAME);
}

function validateEntry(obj: unknown): RenameLogEntry | null {
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.from !== 'string' || o.from.length === 0) return null;
  if (typeof o.to !== 'string' || o.to.length === 0) return null;
  if (o.from === o.to) return null;
  if (typeof o.at !== 'string' || o.at.length === 0) return null;
  if (typeof o.commitSha !== 'string') return null;
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
  const displaced = index.byTo.get(entry.to);
  if (displaced) removeFromByFrom(index, displaced);
  index.byTo.set(entry.to, entry);
  const fromBucket = index.byFrom.get(entry.from);
  if (fromBucket) fromBucket.push(entry);
  else index.byFrom.set(entry.from, [entry]);
}

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
    } catch {}
  }
  tracedAppendFileSync(path, serialized, { flag: 'a' });
  indexInsert(index, validated);
  liveEntriesGauge().add(1);

  if (overCap && shadow) {
    scheduleHardCapGc(shadow, index);
  }
}

const gcPending: Set<string> = new Set();

function scheduleHardCapGc(shadow: ShadowHandle, index: RenameLogIndex): void {
  queueMicrotask(() => {
    gcRenameLog(shadow, index).catch((err) => {
      console.warn('[rename-log] WARN: hard-cap forced GC failed:', err);
    });
  });
}

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

export function serializeIndexToString(index: RenameLogIndex): string {
  const lines: string[] = [];
  for (const entry of index.byTo.values()) {
    lines.push(JSON.stringify(entry));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function parseGitTimeoutMs(): number {
  const raw = process.env.OK_GIT_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

interface PredecessorChainEntry {
  path: string;
  renameCommit: string | null;
}

export const MAX_PREDECESSOR_CHAIN_DEPTH = 100;

interface PredecessorChainResult {
  chain: PredecessorChainEntry[];
  skipped: number;
}

export function expandPredecessors(
  currentDocName: string,
  branch: string,
  index: RenameLogIndex,
): PredecessorChainResult {
  const chain: PredecessorChainEntry[] = [];
  const visited = new Set<string>();
  let cursor: string = currentDocName;
  let skipped = 0;
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
  chain.reverse();
  chain.push({ path: currentDocName, renameCommit: null });
  return { chain, skipped };
}

export type AncestorShaSetCache = Map<string, Set<string>>;

export function createAncestorShaSetCache(): AncestorShaSetCache {
  return new Map();
}

export type SeedsCache = Map<string, string[]>;

export function createSeedsCache(): SeedsCache {
  return new Map();
}

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

const REV_LIST_STDIN_THRESHOLD_BYTES = 100 * 1024;

async function revListReachable(shadow: ShadowHandle, refs: string[]): Promise<string> {
  if (refs.length === 0) return '';
  const argBytes = refs.reduce((acc, r) => acc + r.length + 1, 0);
  if (argBytes < REV_LIST_STDIN_THRESHOLD_BYTES) {
    return shadowGit(shadow).raw('rev-list', ...refs);
  }
  const timeoutMs = parseGitTimeoutMs();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['rev-list', '--stdin'], {
      env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      } catch {}
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
    const args = ['log', '--stdin', ...flags, ...(pathspec ? ['--', pathspec] : [])];
    const child = spawn('git', args, {
      env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      } catch {}
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

export function batchCheckExistence(
  shadow: ShadowHandle,
  probes: Array<{ sha: string; path: string }>,
): Promise<boolean[]> {
  if (probes.length === 0) return Promise.resolve([]);

  const timeoutMs = parseGitTimeoutMs();

  return new Promise<boolean[]>((resolvePromise) => {
    const child = spawn('git', ['cat-file', '--batch-check', '--buffer'], {
      env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

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
      } catch {}
      settle(allFalse());
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`[rename-log] WARN: batchCheckExistence spawn error: ${err.message}`);
      settle(allFalse());
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if ((code !== null && code !== 0) || (signal && !settled)) {
        console.warn(
          `[rename-log] WARN: batchCheckExistence exited code=${code} signal=${signal ?? 'none'}; returning all-false`,
        );
        settle(allFalse());
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const lines = stdout.split('\n').filter((l) => l.length > 0);
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
  const tmp = `${path}.tmp`;
  try {
    tracedWriteFileSync(tmp, serialized);
    tracedRenameSync(tmp, path);
  } catch (err) {
    console.warn('[rename-log] WARN: atomic rewrite failed; index ahead of disk:', err);
    try {
      if (existsSync(tmp)) tracedUnlinkSync(tmp);
    } catch {}
  }
}

export function backfillRenameLogCommitSha(
  shadowDir: string,
  writerId: string,
  commitSha: string,
  index: RenameLogIndex,
): { updated: number } {
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

  const candidates: Array<{ entry: RenameLogEntry; observedSha: string }> = [];
  for (const entry of index.byTo.values()) {
    if (entry.commitSha === '') continue;
    candidates.push({ entry, observedSha: entry.commitSha });
  }

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

  const beforeCount = index.byTo.size;
  result.scanned = beforeCount;

  const toDrop: RenameLogEntry[] = [];
  for (const { entry, observedSha } of candidates) {
    if (liveShas.has(observedSha)) continue;
    const current = index.byTo.get(entry.to);
    if (current === entry && entry.commitSha === observedSha) {
      toDrop.push(entry);
    }
  }

  for (const entry of toDrop) {
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
      console.warn(
        '[rename-log] WARN: gcRenameLog rebuild: git log --grep failed; skipping reconstruction:',
        err,
      );
      logRaw = '';
    }

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

      let totalPairs = 0;
      for (const actor of actors) {
        totalPairs += actor.previous_paths?.length ?? 0;
      }
      if (totalPairs === 0) continue;
      const kind: 'file' | 'folder' = totalPairs > 1 ? 'folder' : 'file';

      const branchFromRefs = lookupBranchInMap(branchReachability, sha);
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
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function buildBranchReachabilityMap(
  shadow: ShadowHandle,
  refLines: string[],
): Promise<Map<string, Set<string>>> {
  const branchRefs = new Map<string, string[]>();
  for (const ref of [...refLines].sort()) {
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

function lookupBranchInMap(map: Map<string, Set<string>>, sha: string): string {
  for (const [branch, shas] of map) {
    if (shas.has(sha)) return branch;
  }
  return 'main';
}

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

  const predecessorAncestors: Array<Set<string> | null> = await Promise.all(
    chain.map(async (step) => {
      if (step.renameCommit === null) return null;
      const seeds = await buildSeeds(shadow, step.renameCommit, branch, seedsCache);
      if (seeds.length === 0) return new Set<string>();
      return buildAncestorShaSet(shadow, seeds, branch, cache);
    }),
  );

  const probes: Array<{ sha: string; path: string }> = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = chain[i];
    const ancestors = predecessorAncestors[i];
    if (ancestors !== null && !ancestors.has(commitSha)) continue;
    probes.push({ sha: commitSha, path: pathFor(step.path) });
  }

  if (probes.length === 0) return null;

  const results = await batchCheckExistence(shadow, probes);

  for (let i = 0; i < probes.length; i++) {
    if (results[i]) return probes[i].path;
  }
  return null;
}
