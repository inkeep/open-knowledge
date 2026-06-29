import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface PathEntry {
  relPath: string;
  size: number;
  hash: string;
}

export interface Manifest {
  files: Record<string, PathEntry>;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const SNAPSHOT_EXCLUDED_DIRS = new Set([
  '.ok',
  '.git',
  'node_modules',
  '.claude',
  '.cursor',
  '.codex',
  '.opencode',
  '.agents',
]);

export function snapshotDir(root: string): Manifest {
  const files: Record<string, PathEntry> = {};
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (SNAPSHOT_EXCLUDED_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const buf = readFileSync(full);
        const rel = relative(root, full);
        files[rel] = { relPath: rel, size: st.size, hash: sha256(buf) };
      }
    }
  }
  walk(root);
  return { files };
}

export function snapshotMarkdownOnly(root: string): Manifest {
  const all = snapshotDir(root);
  const filtered: Record<string, PathEntry> = {};
  for (const [rel, entry] of Object.entries(all.files)) {
    const ext = extname(rel).toLowerCase();
    if (ext === '.md' || ext === '.mdx') filtered[rel] = entry;
  }
  return { files: filtered };
}

export interface DiffEntry {
  relPath: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  beforeHash?: string;
  afterHash?: string;
  beforeSize?: number;
  afterSize?: number;
}

export function diffManifest(before: Manifest, after: Manifest): DiffEntry[] {
  const out: DiffEntry[] = [];
  const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const k of keys) {
    const b = before.files[k];
    const a = after.files[k];
    if (b && a) {
      out.push({
        relPath: k,
        status: b.hash === a.hash ? 'unchanged' : 'modified',
        beforeHash: b.hash,
        afterHash: a.hash,
        beforeSize: b.size,
        afterSize: a.size,
      });
    } else if (b) {
      out.push({ relPath: k, status: 'removed', beforeHash: b.hash, beforeSize: b.size });
    } else if (a) {
      out.push({ relPath: k, status: 'added', afterHash: a.hash, afterSize: a.size });
    }
  }
  return out;
}

export function mutationsOf(diff: DiffEntry[]): DiffEntry[] {
  return diff.filter((e) => e.status !== 'unchanged');
}
