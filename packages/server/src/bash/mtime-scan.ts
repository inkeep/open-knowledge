import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { argsOf, nonFlagArgs } from './extract-paths.ts';
import { isRecursiveGrepFlag, type Stage } from './parse-command.ts';

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

function literalDirPrefix(token: string): string {
  const idx = token.search(GLOB_RE);
  const head = token.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash >= 0 ? head.slice(0, slash) : SCAN_WHOLE_TREE;
}

export function deriveScanRoots(stages: Stage[]): string[] {
  const roots = new Set<string>();
  for (const stage of stages) {
    const args = argsOf(stage);
    const positional = nonFlagArgs(args);
    let candidates: string[];
    switch (stage.command) {
      case 'grep': {
        let patternViaFlag = false;
        const patternValues = new Set<string>();
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-e' || a === '--regexp') {
            patternViaFlag = true;
            const value = args[i + 1];
            if (value !== undefined) patternValues.add(value);
          } else if (a.startsWith('--regexp=')) {
            patternViaFlag = true;
          }
        }
        const operands = positional.filter((p) => !patternValues.has(p));
        candidates = patternViaFlag ? operands : operands.slice(1);
        if (candidates.length === 0 && args.some(isRecursiveGrepFlag)) {
          roots.add(SCAN_WHOLE_TREE);
        }
        break;
      }
      case 'find': {
        const firstFlag = args.findIndex((a) => a.startsWith('-'));
        const pathRoots = firstFlag === -1 ? args : args.slice(0, firstFlag);
        const predicateValues =
          firstFlag === -1
            ? []
            : args.slice(firstFlag).filter((a) => !a.startsWith('-') && !GLOB_RE.test(a));
        candidates = [...pathRoots, ...predicateValues];
        if (pathRoots.length === 0) roots.add(SCAN_WHOLE_TREE);
        break;
      }
      case 'ls': {
        candidates = positional;
        if (positional.length === 0) roots.add(SCAN_WHOLE_TREE);
        break;
      }
      default:
        candidates = positional;
    }
    const attached = args
      .filter((a) => a.startsWith('-') && a.includes('='))
      .map((a) => a.slice(a.indexOf('=') + 1))
      .filter((v) => v.length > 0 && !GLOB_RE.test(v));
    for (const c of [...candidates, ...attached]) {
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
