/**
 * Disk-byte snapshot/diff helpers for the init-load-byte-stable regression
 * guards. Shared between the Bun integration test and the
 * Playwright e2e test; both tiers
 * exercise the same disk byte-stability property and need identical
 * snapshot/diff semantics for their assertions to mean the same thing.
 *
 * Pure functions — no test-runner dependencies, no globals. Safe to import
 * from both `bun:test` and `@playwright/test` consumers.
 */

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

/**
 * Directories excluded from the snapshot — infrastructure, not user content.
 * `.ok/` (init artifact), `.git/` (git metadata), `node_modules/`, and the
 * editor / agent tool dirs: `ok init` installs the project-local skill into
 * every configured editor's skills root (`.claude/skills/`, `.cursor/skills/`,
 * `.codex/skills/`, `.opencode/skills/`, plus the generic `.agents/skills/`).
 * Those SKILL.md files are tool-config artifacts, not user knowledge-base
 * content — the load-without-mutate property is about user `.md` / `.mdx`
 * content only. This set must cover every `EDITOR_PROJECT_SKILL_ROOT` top-level
 * dir in core; a new skill-surface editor that projects into a fresh dotdir
 * would otherwise surface here as a phantom corpus mutation.
 */
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

/**
 * Snapshot every file under `root`, EXCLUDING the infrastructure directories
 * in `SNAPSHOT_EXCLUDED_DIRS`. Returns a per-relpath SHA-256 manifest.
 */
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

/**
 * Markdown-only snapshot — restricts to `.md`/`.mdx` files. The
 * load-without-mutate property is specifically about user content paths;
 * `.ok/` and `.git/` are tracked separately (and excluded from this view
 * by `snapshotDir`'s filter).
 */
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

/**
 * Filter a diff to entries that represent a load-path mutation: anything
 * other than `unchanged`. Includes `added` so a regression that introduces
 * a new sidecar file (e.g. `.frontmatter.yml`, `_meta.json` — explicitly
 * forbidden by the AGENTS.md "No OK sidecars in user-content paths" STOP
 * rule) is detected, not just modified-in-place corpus files.
 */
export function mutationsOf(diff: DiffEntry[]): DiffEntry[] {
  return diff.filter((e) => e.status !== 'unchanged');
}
