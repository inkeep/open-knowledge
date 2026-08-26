/**
 * Wire contract for `GET /api/git/worktree-status` — the working-tree view the
 * sync popover renders as a `git status` equivalent.
 *
 * Distinct from `SyncStatusSchema` (`sync-seed.ts`), which reports the *engine's*
 * state machine. This reports the *repository's* state: which files are staged,
 * modified, or untracked right now. The two are refreshed on different cadences
 * (the engine pushes over CC1 `sync-status`; this is polled on popover open), so
 * they stay separate payloads rather than one fat status object.
 *
 * `ahead`/`behind` deliberately do NOT appear here — the engine already owns
 * them and streams them over CC1. Duplicating them would give the popover two
 * sources for one number that could disagree mid-fetch.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/**
 * Porcelain status letters a single column can carry. Mirrors
 * `git status --porcelain` v1: ` MADRCU?!`. Kept as a bounded enum rather than
 * a free string so the UI's letter→label mapping is total and a future git
 * version cannot smuggle an unrendered glyph into the popover.
 */
export const GIT_STATUS_CODES = ['M', 'A', 'D', 'R', 'C', 'U', 'T', '?', '!', ' '] as const;
export type GitStatusCode = (typeof GIT_STATUS_CODES)[number];

/**
 * One changed path in the working tree.
 *
 * `code` is the single porcelain letter for the column this entry was filed
 * under — the index letter (X) for a staged entry, the worktree letter (Y) for
 * an unstaged one, `'?'` for untracked. A path modified both in the index and
 * in the worktree appears in BOTH lists with its respective letter, which is
 * exactly what `git status` shows.
 *
 * `syncScoped` is the load-bearing field: false means Open Knowledge will never
 * commit this path, no matter how many times the user presses Push. The listing
 * shows out-of-scope paths (they are the usual cause of a blocked merge) but
 * must mark them, or Push silently ignoring a visible file reads as a bug.
 *
 * `open` is orthogonal to `syncScoped`: a gitignored note is openable but never
 * pushed, and `opencode.json` is pushed and opens as an asset, not a doc.
 */
export const GitWorktreeEntrySchema = z
  .object({
    /**
     * Project-relative POSIX path, reported faithfully — including names the
     * document and search surfaces suppress as secret-bearing (`.env`,
     * `id_ed25519`, `*.pem`).
     *
     * Deliberate, and the asymmetry with `open` below is deliberate too: this
     * is a `git status` view, and an untracked secret file is a real merge
     * blocker (git refuses a merge that would overwrite it), so suppressing the
     * row produces a paused sync with no visible cause — the failure this
     * listing exists to prevent. The row is still marked out-of-scope and stays
     * unclickable; only the name ships.
     *
     * The exposure is narrower than it looks: the caller never passes
     * `--ignored`, so a gitignored secret never reaches this surface at all.
     * The only window is a secret file created but not yet added to
     * `.gitignore` — which is exactly the case that can block a merge.
     */
    path: z.string().min(1),
    code: z.enum(GIT_STATUS_CODES),
    /** Rename/copy origin path; present only when `code` is `R` or `C`. */
    origPath: z.string().min(1).optional(),
    /** True when this path is inside Open Knowledge's commit scope. */
    syncScoped: z.boolean(),
    /**
     * Where clicking this row lands, or absent when it lands nowhere.
     *
     * The two arms are the two routes the Files sidebar itself uses, so a row
     * opens exactly what double-clicking the same file in the tree opens:
     * `doc` for a document the editor owns, `asset` for everything else — the
     * read-only viewer, which falls back to a "view as text / open file" pane
     * for extensions it has no renderer for. Absent for a path outside the
     * content dir, a file that no longer exists (a deletion, or an incoming
     * file that has not landed yet), and for the floors the sidebar itself
     * never shows: secret-bearing files, `.git`, `node_modules`, `.ok/local`.
     *
     * Note the deliberate split with `path` above: the floors gate what a row
     * LINKS to, not whether the row is listed. See `path` for why.
     */
    open: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('doc'), docName: z.string().min(1) }),
        z.object({ kind: z.literal('asset'), path: z.string().min(1) }),
      ])
      .optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type GitWorktreeEntry = z.infer<typeof GitWorktreeEntrySchema>;
/** Where a working-tree row navigates when clicked. */
export type GitWorktreeOpenTarget = NonNullable<GitWorktreeEntry['open']>;

/**
 * Success body for `GET /api/git/worktree-status`.
 *
 * `truncated` is set when the working tree carried more changed paths than the
 * response cap. A repository mid-rebase or with a stale build directory can
 * produce tens of thousands of porcelain records; the popover renders a bounded
 * list and says so rather than shipping an unbounded payload to the renderer.
 */
export const GitWorktreeStatusSuccessSchema = z
  .object({
    /** Current branch, or null when HEAD is detached or unborn. */
    branch: z.string().nullable(),
    detached: z.boolean(),
    /** Upstream tracking ref (e.g. `origin/main`), or null when unset. */
    upstream: z.string().nullable(),
    staged: z.array(GitWorktreeEntrySchema),
    notStaged: z.array(GitWorktreeEntrySchema),
    untracked: z.array(GitWorktreeEntrySchema),
    /**
     * Files a pull would bring in: the diff from HEAD to the tracking ref.
     *
     * Only as fresh as the last fetch — this is a local ref-to-ref diff, never
     * a network call. Empty when the branch has no upstream, when HEAD is
     * unborn, or when nothing is incoming.
     *
     * `syncScoped` is meaningless here and is always true: it answers "would
     * Push send this", and a pull is unscoped — git merges whatever the remote
     * carries, including paths Open Knowledge would never have pushed.
     */
    incoming: z.array(GitWorktreeEntrySchema),
    truncated: z.boolean(),
    /**
     * Whether the working-tree read actually succeeded.
     *
     * Without this a failed `git status` was indistinguishable on the wire from
     * a genuinely clean tree — all lists empty — and the UI stated "Nothing to
     * commit, working tree clean", which is a false claim about the user's data
     * at the moment they are deciding whether to reset or switch machines. The
     * reachable causes are exactly the ones worth surfacing: a corrupt index, an
     * interrupted rebase, EACCES, a lock held by another process.
     *
     * Defaults to `true` so a server that predates the field does not read as
     * permanently unreadable to a newer client.
     */
    readable: z.boolean().default(true),
  })
  .loose() satisfies StandardSchemaV1;
export type GitWorktreeStatusSuccess = z.infer<typeof GitWorktreeStatusSuccessSchema>;
