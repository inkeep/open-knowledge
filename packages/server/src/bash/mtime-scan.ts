import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { argsOf } from './extract-paths.ts';
import {
  attachedValueMayNamePath,
  classifyArgs,
  isRecursiveGrepFlag,
  type Stage,
} from './parse-command.ts';

export const SCAN_CAP = 1000;

export const SCAN_WHOLE_TREE = '';

const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  OK_DIR,
  'node_modules',
  '.changeset',
  '.claude',
  '.agents',
  'dist',
  'build',
]);

type MtimeSnapshot = Map<string, number>;

interface SnapshotResult {
  snapshot: MtimeSnapshot;
  truncated: boolean;
}

const GLOB_RE = /[*?[]/;
const NUMERIC_RE = /^[+-]?\d+$/;

function literalDirPrefix(token: string): string {
  const idx = token.search(GLOB_RE);
  const head = token.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash >= 0 ? head.slice(0, slash) : SCAN_WHOLE_TREE;
}

const NON_PATH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--exclude',
  '--exclude-dir',
  '--include',
  '--regexp',
]);

function isScanBase(value: string): boolean {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.';
}

function carriesPathValue(arg: string): boolean {
  const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
  return !NON_PATH_VALUE_FLAGS.has(name);
}

export function deriveScanRoots(stages: Stage[]): string[] {
  const roots = new Set<string>();
  for (const stage of stages) {
    const args = argsOf(stage);
    const classified = classifyArgs(stage);
    const paths = classified.filter((a) => a.role === 'path');
    const operands = paths.filter((a) => a.flag === undefined).map((a) => a.value);

    const ambiguous = classified
      .filter(
        (a) =>
          a.role === 'attached-value' &&
          a.flag !== undefined &&
          carriesPathValue(a.flag) &&
          attachedValueMayNamePath(stage.command, a.flag),
      )
      .map((a) => a.value)
      .filter((v) => v.length > 0 && !NUMERIC_RE.test(v) && !GLOB_RE.test(v) && !isScanBase(v));

    if (operands.length === 0) {
      const bare = stage.command === 'ls' || stage.command === 'find';
      if (bare || (stage.command === 'grep' && args.some(isRecursiveGrepFlag))) {
        roots.add(SCAN_WHOLE_TREE);
      }
    }

    for (const c of [...paths.map((a) => a.value), ...ambiguous]) {
      roots.add(GLOB_RE.test(c) ? literalDirPrefix(c) : c);
    }
  }
  return roots.has(SCAN_WHOLE_TREE) ? [SCAN_WHOLE_TREE] : [...roots];
}

function hasSkippedSegment(rel: string): boolean {
  return rel.split('/').some((seg) => SKIP_DIRS.has(seg));
}

export async function snapshotMtimesForRoots(
  baseDir: string,
  roots: readonly string[],
  cap: number = SCAN_CAP,
): Promise<SnapshotResult> {
  const base = resolve(baseDir);
  const snapshot: MtimeSnapshot = new Map();
  const state = { truncated: false };

  function record(relPath: string, mtimeMs: number): void {
    if (snapshot.has(relPath)) return;
    if (snapshot.size >= cap) {
      state.truncated = true;
      return;
    }
    snapshot.set(relPath, mtimeMs);
  }

  async function walk(dir: string): Promise<void> {
    if (state.truncated) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (state.truncated) return;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const s = await stat(full);
        record(relative(base, full), s.mtimeMs);
      } catch {}
    }
  }

  const effectiveRoots = roots.includes(SCAN_WHOLE_TREE) ? [SCAN_WHOLE_TREE] : [...new Set(roots)];
  for (const root of effectiveRoots) {
    if (state.truncated) break;
    if (root !== SCAN_WHOLE_TREE && hasSkippedSegment(root)) continue;
    const abs = resolve(base, root);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(abs);
    } else if (s.isFile()) {
      record(relative(base, abs), s.mtimeMs);
    }
  }
  return { snapshot, truncated: state.truncated };
}

export async function snapshotMtimes(
  projectDir: string,
  cap: number = SCAN_CAP,
): Promise<SnapshotResult> {
  return snapshotMtimesForRoots(projectDir, [SCAN_WHOLE_TREE], cap);
}

interface MtimeDiff {
  changed: string[];
}

export function diffMtimes(before: MtimeSnapshot, after: MtimeSnapshot): MtimeDiff {
  const changed: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined || prev !== mtime) {
      changed.push(path);
    }
  }
  for (const [path] of before) {
    if (!after.has(path)) changed.push(path);
  }
  return { changed };
}
