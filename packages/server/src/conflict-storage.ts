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
import { ConflictMarkersInContentError, NoConflictTrackedError } from './conflict-errors.ts';
import { isShareableOkArtifact } from './content-filter.ts';
import { tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';
import { listNames } from './git-paths.ts';
import { getLogger } from './logger.ts';
import { isWithinDir } from './path-utils.ts';
import { containsUnresolvedConflictBlock } from './reconciliation.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';

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
  /**
   * `'working-tree'` marks a pull-only overlay conflict: the branch is already
   * at origin tip and the local edit rides uncommitted on top, so there is no
   * unmerged index / MERGE_HEAD to resolve against. Absent (the default) means
   * a git-merge-native conflict resolved through the index stages.
   */
  variant?: 'working-tree';
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

  /** Persist current state to disk. Returns false when the disk write failed. */
  save(): boolean {
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
      return true;
    } catch (e) {
      log.warn({ err: e }, '[conflicts] failed to save conflicts.json');
      return false;
    }
  }

  /**
   * Add a new conflict entry (idempotent by file path). Returns false when the
   * in-memory upsert succeeded but the disk persist failed — the caller must
   * decide whether that divergence (a conflict shown this session but absent
   * from conflicts.json after a restart) is tolerable.
   */
  addConflict(entry: ConflictEntry): boolean {
    // Invariant: a working-tree (pull-only overlay) entry must carry the pinned
    // origin blob — the 'theirs' resolution reads it back by SHA. The optional
    // `theirsSha` field can't express this at the type level, so fail loudly at
    // insert time rather than with an opaque throw at resolve time.
    if (entry.variant === 'working-tree' && !entry.theirsSha) {
      throw new Error(
        `[conflicts] working-tree conflict for ${entry.file} has no pinned theirs blob`,
      );
    }
    const existing = this.conflicts.findIndex((c) => c.file === entry.file);
    if (existing !== -1) {
      this.conflicts[existing] = entry; // update if already tracked
    } else {
      this.conflicts.push(entry);
    }
    return this.save();
  }

  /**
   * Remove a conflict entry by file path. Returns false when the in-memory
   * removal succeeded but the disk persist failed.
   */
  removeConflict(file: string): boolean {
    this.conflicts = this.conflicts.filter((c) => c.file !== file);
    return this.save();
  }

  /** Remove all conflicts for the current branch. */
  clear(): void {
    this.conflicts = [];
    // Lower stakes than the resolve paths — a failed persist here leaves a
    // ledger listing conflicts the branch no longer has — but the same
    // discarded signal, so it completes the sweep rather than leaving one
    // call site silently different from its siblings.
    if (!this.save()) {
      log.error(
        { branch: this.branch },
        '[conflicts] cleared conflicts in memory but conflicts.json persist failed — the ledger will resurrect them on restart',
      );
    }
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
   */
  async resolveConflict(file: string, strategy: ResolveStrategy, content?: string): Promise<void> {
    const entry = this.conflicts.find((c) => c.file === file);
    if (!entry) {
      throw new NoConflictTrackedError({ file });
    }

    // Content carrying conflict markers is a broken file, not a resolution, and
    // this call would write it, commit it, and clear the tracked conflict — so
    // the document keeps the markers as literal text while the UI reports the
    // conflict solved. Observed from an agent handed an unsatisfiable
    // instruction ("resolve only this region"), where emitting markers was the
    // only way to obey. The refusal lives here rather than in a tool prompt
    // because prompts are editable by the user and ignorable by the model,
    // while every caller reaches this method.
    //
    // Order relative to the lookup above is deliberately NOT load-bearing. It
    // was, while `!entry` threw bare: whichever check ran second lost, because
    // a bare throw became a generic 500 that tells an agent to retry. Both are
    // typed now, so each ordering reports something true — and this one reports
    // the more useful thing first, since a caller with a stale path has no
    // byte problem to fix.
    if (
      strategy === 'content' &&
      content !== undefined &&
      containsUnresolvedConflictBlock(content)
    ) {
      throw new ConflictMarkersInContentError({ file });
    }

    // Validate strategy-specific params before touching git
    if (strategy === 'content' && content === undefined) {
      throw new Error(`[conflicts] strategy 'content' requires content parameter`);
    }

    // Pull-only overlay conflicts resolve without any index/commit — split off
    // before the merge-native path so its `git checkout --ours/--theirs` +
    // `git commit --no-edit` semantics stay untouched.
    if (entry.variant === 'working-tree') {
      await this.resolveWorkingTreeConflict(entry, strategy, content);
      return;
    }

    // Dynamic import so CRUD tests don't load simple-git (broken symlink in test env)
    // No credential config: every git op below is local (checkout/add/rm/commit).
    const { createGitInstance } = await import('./git-handle.ts');
    const handle = createGitInstance(this.projectDir, { credentialConfig: [] });

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
        // Lexical containment alone lets a symlink materialized by the merge at
        // the conflicted path escape the tree on write; the working-tree path
        // already realpath-guards, so mirror it here and route through the
        // traced fs wrapper like every other server-side disk write.
        assertRealpathWithinDir(absPath, projectRoot, {
          allowShareableOkArtifact: isShareableOkArtifact,
        });
        tracedWriteFileSync(absPath, content, 'utf-8');
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

    // Snapshot detection times BEFORE the removal below, so the commit-failure
    // path can re-add these conflicts as the same ones rather than as newly
    // detected. See the re-add in that catch.
    const priorDetectedAt = new Map<string, string>(
      this.list().map((entry) => [entry.file, entry.detectedAt] as const),
    );

    // Remove from store — but defer final removal if this is the last conflict
    // so we can re-add on commit failure (prevents losing conflict from UI while
    // git is still in half-merged state).
    //
    // Same persist divergence as the working-tree path, and the harder of the
    // two to correlate from logs: this is the branch that goes on to run
    // `git commit --no-edit`, so the generic `save()` warn lands amid commit
    // noise with no file name on it.
    if (!this.removeConflict(file)) {
      log.error(
        { file },
        '[conflicts] resolve dropped the conflict in memory but conflicts.json persist failed — the ledger will resurrect this conflict on restart',
      );
    }

    // If all conflicts resolved, create the merge commit
    if (!this.hasConflicts()) {
      try {
        await handle.git.raw(['commit', '--no-edit']);
        log.info({ file }, '[conflicts] all conflicts resolved — merge commit created');
      } catch (e) {
        // Commit failed — the git index may still contain unmerged entries from
        // other files the user resolved earlier in this merge. Re-scan the
        // index so every unmerged file is visible again, not just `file`.
        // NOT COVERED BY A UNIT TEST. Reaching this branch needs a working git
        // that then fails to commit; without git the resolve throws at `git
        // add` and never arrives, and with only in-memory entries the commit is
        // never attempted at all. Two attempts at a unit test passed whether or
        // not the preservation below was present. It wants an integration
        // fixture that stages a real merge and forces the commit to fail.
        //
        // Detection timestamps are PRESERVED across this re-add. A failed commit
        // is not a new detection — these conflicts have been standing since
        // they were first found. Re-minting `detectedAt` changed the identity
        // the client keys its conflict-content fetch on, so an open resolution
        // was torn down and its undo history discarded. Worse, the re-scan
        // re-adds every unmerged file, so failing the commit on one file reset
        // an open view on another, one CC1 cycle later and long enough after
        // the toast that the two did not look related.
        const fallbackDetectedAt = new Date().toISOString();
        let reAdded = false;
        try {
          // git-paths.ts has no runtime simple-git dependency, so this needs no
          // dynamic import (unlike createGitInstance above) to keep simple-git
          // out of the CRUD-test module graph.
          const unmerged = await listNames(handle.git, ['diff', '--name-only', '--diff-filter=U']);
          for (const f of unmerged) {
            this.addConflict({
              file: f,
              detectedAt: priorDetectedAt.get(f) ?? fallbackDetectedAt,
            });
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
          this.addConflict({ file, detectedAt: priorDetectedAt.get(file) ?? fallbackDetectedAt });
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

  /**
   * Resolve a pull-only overlay conflict. The branch already fast-forwarded to
   * origin tip and the local overlay is uncommitted on top, so there is no
   * unmerged index: resolution writes the chosen bytes straight to the working
   * tree and NEVER runs `git checkout --ours/--theirs` or `git commit` — the
   * engine never commits on a pull-only user's behalf.
   *
   *   'mine'    — keep the local overlay verbatim (no disk write)
   *   'theirs'  — restore the pinned origin-tip blob to disk
   *   'content' — write the caller-supplied merged bytes to disk
   *   'delete'  — honor a local deletion (remove the file)
   *
   * After resolving, the entry is removed. The branch stays at origin tip in
   * every case; keep-mine leaves the overlay in place against the advanced tip.
   */
  private async resolveWorkingTreeConflict(
    entry: ConflictEntry,
    strategy: ResolveStrategy,
    content: string | undefined,
  ): Promise<void> {
    const projectRoot = resolve(this.projectDir);
    const absPath = resolve(projectRoot, entry.file);
    if (!isWithinDir(absPath, projectRoot)) {
      throw new Error(`[conflicts] file path escapes project directory: ${entry.file}`);
    }
    // Lexical containment is not enough: an untrusted origin can ship a symlink
    // at a tracked content path, and `writeFileSync`/`unlinkSync` would follow
    // it out of the working tree. Refuse when the realpath escapes.
    assertRealpathWithinDir(absPath, projectRoot, {
      allowShareableOkArtifact: isShareableOkArtifact,
    });

    // Drop the entry BEFORE touching disk. Writing first opens a window the
    // file watcher can land in: it re-seeds the doc from disk, and
    // `conflict-lifecycle-seed` re-marks `lifecycle.status = 'conflict'`
    // because the store still lists this file. That re-mark can arrive after
    // the resolve's own clear, leaving the doc permanently flagged as
    // conflicted with no store entry behind it — the editor stays swapped to
    // the conflict view, which then finds nothing to fetch.
    //
    // Unlike the merge-native path there is no commit to roll back here, so
    // the only thing to undo is the removal itself if the write throws.
    const restoreOnFailure = { ...entry };
    // `removeConflict` returns false when the in-memory drop landed but the
    // conflicts.json persist did not. `save()` already warns generically on
    // that failure; what this adds is the file name and the consequence — after
    // a restart the ledger still lists a file whose overlay is gone, so the
    // editor swaps to a conflict view with nothing to fetch, the exact state
    // the drop-before-write ordering exists to avoid. Message text is identical
    // on the merge-native path so one grep finds both.
    if (!this.removeConflict(entry.file)) {
      log.error(
        { file: entry.file },
        '[conflicts] resolve dropped the conflict in memory but conflicts.json persist failed — the ledger will resurrect this conflict on restart',
      );
    }

    try {
      await this.applyWorkingTreeStrategy(absPath, projectRoot, entry, strategy, content);
    } catch (err) {
      // `addConflict` returns false when the in-memory upsert landed but the
      // conflicts.json persist did not, and its contract puts the call on the
      // caller. Ignored, that divergence survives a restart as a ledger that
      // reads resolved over a working tree still holding the overlay — the
      // user has no conflict left to act on.
      if (!this.addConflict(restoreOnFailure)) {
        log.error(
          { file: entry.file, err },
          '[conflicts] resolve rolled back in memory but conflicts.json persist failed — the ledger will lose this conflict on restart',
        );
      }
      throw err;
    }
  }

  /**
   * The disk half of `resolveWorkingTreeConflict`, split out so the store
   * removal can be ordered ahead of it and restored if it throws.
   */
  private async applyWorkingTreeStrategy(
    absPath: string,
    projectRoot: string,
    entry: ConflictEntry,
    strategy: ResolveStrategy,
    content: string | undefined,
  ): Promise<void> {
    switch (strategy) {
      case 'mine':
        // The working tree already holds the overlay — keep it as-is.
        break;

      case 'theirs': {
        if (!entry.theirsSha) {
          throw new Error(
            `[conflicts] working-tree conflict for ${entry.file} has no pinned theirs blob`,
          );
        }
        const { createGitInstance } = await import('./git-handle.ts');
        // Local-only `cat-file` read — no credential config needed.
        const handle = createGitInstance(this.projectDir, { credentialConfig: [] });
        const theirsBytes = await handle.git.raw(['cat-file', 'blob', entry.theirsSha]);
        // The realpath guard above ran before this `await`, which yielded the
        // event loop; a concurrent pull cycle could have materialized a symlink
        // at absPath in that gap. Re-check immediately before the write, matching
        // applyOverlayPlan's per-write containment.
        assertRealpathWithinDir(absPath, projectRoot, {
          allowShareableOkArtifact: isShareableOkArtifact,
        });
        tracedWriteFileSync(absPath, theirsBytes, 'utf-8');
        break;
      }

      case 'content': {
        if (content === undefined) {
          throw new Error(`[conflicts] strategy 'content' requires content parameter`);
        }
        tracedWriteFileSync(absPath, content, 'utf-8');
        break;
      }

      case 'delete':
        if (existsSync(absPath)) tracedUnlinkSync(absPath);
        break;

      default: {
        const exhaustive: never = strategy;
        throw new Error(`[conflicts] unknown resolve strategy: ${exhaustive}`);
      }
    }
  }
}
