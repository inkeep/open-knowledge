/**
 * ConflictStore — persistent storage and resolution logic for merge conflicts.
 *
 * Conflicts are stored at <projectDir>/.ok/local/conflicts.json (schema v1).
 * Each conflict entry records the file path and optional git object SHAs for
 * ours/theirs/base, enabling strategy-based resolution.
 *
 * Per-machine runtime state lives at the project root, not inside the content
 * sub-folder, so a single project presents one `.ok/local/` regardless of
 * `content.dir`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getLocalDir } from './config/paths.ts';
import { listNames } from './git-paths.ts';
import { getLogger } from './logger.ts';
import { isWithinDir } from './path-utils.ts';

const log = getLogger('conflict-storage');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConflictEntry {
  /** Path of the conflicted file, relative to projectDir (git root). */
  file: string;
  /** ISO-8601 timestamp when the conflict was detected. */
  detectedAt: string;
  /** SHA of our version at conflict time (optional). */
  oursSha?: string;
  /** SHA of their version at conflict time (optional). */
  theirsSha?: string;
  /** SHA of the merge base at conflict time (optional). */
  baseSha?: string;
}

export type ResolveStrategy = 'mine' | 'theirs' | 'content' | 'delete';

/** Schema v1 stored in conflicts.json. */
interface ConflictsJson {
  version: 1;
  branch: string;
  conflicts: ConflictEntry[];
}

// ─── ConflictStore ───────────────────────────────────────────────────────────

export class ConflictStore {
  private readonly storePath: string;
  private readonly projectDir: string;
  private branch: string;
  private conflicts: ConflictEntry[] = [];

  constructor(projectDir: string, branch = 'main') {
    this.storePath = join(getLocalDir(projectDir), 'conflicts.json');
    this.projectDir = projectDir;
    this.branch = branch;
    this.load();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  /** Load conflict state from disk. No-op if file doesn't exist. */
  load(): void {
    if (!existsSync(this.storePath)) {
      this.conflicts = [];
      return;
    }
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<ConflictsJson>;
      if (data.version !== 1) {
        log.warn({ path: this.storePath }, '[conflicts] unknown schema version — resetting');
        this.conflicts = [];
        return;
      }
      this.branch = data.branch ?? this.branch;
      this.conflicts = data.conflicts ?? [];
    } catch (e) {
      log.warn({ err: e }, '[conflicts] failed to load conflicts.json — starting empty');
      this.conflicts = [];
    }
  }

  /** Persist current state to disk. */
  save(): void {
    try {
      const dir = dirname(this.storePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: ConflictsJson = {
        version: 1,
        branch: this.branch,
        conflicts: this.conflicts,
      };
      writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      log.warn({ err: e }, '[conflicts] failed to save conflicts.json');
    }
  }

  /** Add a new conflict entry (idempotent by file path). */
  addConflict(entry: ConflictEntry): void {
    const existing = this.conflicts.findIndex((c) => c.file === entry.file);
    if (existing !== -1) {
      this.conflicts[existing] = entry; // update if already tracked
    } else {
      this.conflicts.push(entry);
    }
    this.save();
  }

  /** Remove a conflict entry by file path. */
  removeConflict(file: string): void {
    this.conflicts = this.conflicts.filter((c) => c.file !== file);
    this.save();
  }

  /** Remove all conflicts for the current branch. */
  clear(): void {
    this.conflicts = [];
    this.save();
  }

  /** Number of unresolved conflicts. */
  count(): number {
    return this.conflicts.length;
  }

  /** All unresolved conflicts. */
  list(): ConflictEntry[] {
    return [...this.conflicts];
  }

  /** True if there are any unresolved conflicts. */
  hasConflicts(): boolean {
    return this.conflicts.length > 0;
  }

  /** Update the active branch (called on branch switch). */
  setBranch(branch: string): void {
    this.branch = branch;
  }

  // ─── Resolution ──────────────────────────────────────────────────────────

  /**
   * Resolve a single conflict.
   *
   * Strategy:
   *   'mine'    — checkout --ours  <file> + git add
   *   'theirs'  — checkout --theirs <file> + git add
   *   'content' — write provided content to disk, then git add
   *
   * After resolving, the entry is removed from the store.
   * If all conflicts are now resolved, a merge commit is created to finalise the merge.
   *
   * @param file     File path relative to projectDir.
   * @param strategy How to resolve.
   * @param content  Required when strategy === 'content'.
   * @param credentialArgs  Credential args for the git handle.
   */
  async resolveConflict(
    file: string,
    strategy: ResolveStrategy,
    content?: string,
    credentialArgs: string[] = [],
  ): Promise<void> {
    const entry = this.conflicts.find((c) => c.file === file);
    if (!entry) {
      throw new Error(`[conflicts] no conflict tracked for file: ${file}`);
    }

    // Validate strategy-specific params before touching git
    if (strategy === 'content' && content === undefined) {
      throw new Error(`[conflicts] strategy 'content' requires content parameter`);
    }

    // Dynamic import so CRUD tests don't load simple-git (broken symlink in test env)
    const { createGitInstance } = await import('./git-handle.ts');
    const handle = createGitInstance(this.projectDir, { credentialArgs });

    switch (strategy) {
      case 'mine':
        await handle.git.raw(['checkout', '--ours', '--', file]);
        await handle.git.raw(['add', '--', file]);
        break;

      case 'theirs':
        await handle.git.raw(['checkout', '--theirs', '--', file]);
        await handle.git.raw(['add', '--', file]);
        break;

      case 'content': {
        // Load-bearing for the type-checker, not just defense-in-depth: this
        // standalone check is what narrows `content` from `string | undefined`
        // to `string` for the `writeFileSync` arg below. The pre-switch
        // `strategy === 'content' && content === undefined` guard does NOT
        // narrow across the switch (the compound condition mentions a
        // different variable), so removing this re-check breaks the build.
        // It also stays defensive: the Zod refinement at the API boundary
        // (SyncResolveConflictRequestSchema) already rejects undefined/empty
        // content for the 'content' strategy.
        if (content === undefined) {
          throw new Error(`[conflicts] strategy 'content' requires content parameter`);
        }
        // A malicious git repo could seed `git diff` output with paths containing
        // `..` components; reject anything that escapes projectDir before writing.
        const projectRoot = resolve(this.projectDir);
        const absPath = resolve(projectRoot, file);
        if (!isWithinDir(absPath, projectRoot)) {
          throw new Error(`[conflicts] file path escapes project directory: ${file}`);
        }
        writeFileSync(absPath, content, 'utf-8');
        await handle.git.raw(['add', '--', file]);
        break;
      }

      case 'delete': {
        // Honor the user's deletion intent for delete-vs-modify (DU/UD) shapes.
        // `git rm` removes the working tree entry + stages the deletion in a
        // single atomic call. Unlike the sibling strategies (which write
        // bytes back to disk then `git add` to stage), a subsequent
        // `git add -- <file>` here would fatal with "pathspec did not
        // match any files" because the file no longer exists on disk —
        // `git rm` is self-sufficient. The downstream commit-or-defer
        // path runs identically to the other strategies.
        //
        // STOP-rule exception (fs-traced.ts): git itself is the disk-write
        // operation here, not bare `node:fs` — no fs-traced wrapper needed.
        await handle.git.raw(['rm', '--', file]);
        break;
      }

      default: {
        const exhaustive: never = strategy;
        throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
      }
    }

    // Remove from store — but defer final removal if this is the last conflict
    // so we can re-add on commit failure (prevents losing conflict from UI while
    // git is still in half-merged state).
    this.removeConflict(file);

    // If all conflicts resolved, create the merge commit
    if (!this.hasConflicts()) {
      try {
        await handle.git.raw(['commit', '--no-edit']);
        log.info({ file }, '[conflicts] all conflicts resolved — merge commit created');
      } catch (e) {
        // Commit failed — the git index may still contain unmerged entries from
        // other files the user resolved earlier in this merge. Re-scan the
        // index so every unmerged file is visible again, not just `file`.
        const detectedAt = new Date().toISOString();
        let reAdded = false;
        try {
          // git-paths.ts has no runtime simple-git dependency, so this needs no
          // dynamic import (unlike createGitInstance above) to keep simple-git
          // out of the CRUD-test module graph.
          const unmerged = await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']);
          for (const f of unmerged) {
            this.addConflict({ file: f, detectedAt });
          }
          reAdded = unmerged.length > 0;
        } catch (scanErr) {
          log.warn(
            { err: scanErr },
            '[conflicts] commit failed and re-scan of unmerged files failed — falling back to single-file re-add',
          );
        }
        if (!reAdded) {
          // Either the re-scan failed or reported no unmerged files but the
          // commit still failed — at minimum keep the file we just touched
          // visible so the user has something to act on.
          this.addConflict({ file, detectedAt });
        }
        log.warn(
          { err: e },
          '[conflicts] failed to commit merge after all conflicts resolved — unmerged files re-added',
        );
        // Surface the failure to the API caller. The editor-area DiffView
        // dismisses on 200 OK and only refreshes the conflict list on the
        // next CC1 'sync-status' signal — without this throw the request
        // returns success while conflicts.json silently re-populates,
        // leaving the UI showing a cleared state on a file that the server
        // still treats as unresolved.
        // Embed the git error text into `.message` so operators tailing
        // logs (or hitting `/api/sync/status` post-failure) see the
        // underlying cause without unwrapping `error.cause`.
        const causeText = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Merge commit failed after resolving ${file}; ${reAdded ? 'unmerged files re-added' : 'original file re-added'} — ${causeText}`,
          { cause: e },
        );
      }
    }
  }
}
