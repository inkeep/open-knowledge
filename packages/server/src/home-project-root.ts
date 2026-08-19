/**
 * The one place that answers "is this directory the user's home, and therefore
 * never a project root?" — and the error every scaffold writer throws when it
 * is.
 *
 * `~/.ok/` is OpenKnowledge's own user-global directory (`global.yml`,
 * `skills/`, `auth.yml`), so a project at home writes its `config.yml` into the
 * user-global store. Worse, at home every editor's PROJECT config path resolves
 * onto that editor's USER-GLOBAL config (`~/.cursor/mcp.json`,
 * `~/.codex/config.toml`, `~/.claude/skills/`), so project-scope wiring lands on
 * the user's global install. And `ensureProjectGit` would `git init` the home
 * directory itself.
 *
 * This lives in the server package rather than in any one caller because the
 * scaffold has five entry points that all pass through `ensureProjectGit` and
 * `initContent`: `ok init`, `ok share publish --project-dir`, the desktop's
 * Open Folder confirm, the desktop `ok-init` IPC, and
 * `POST /api/local-op/ok-init`. A per-caller guard is one copy per entry point
 * and one more to forget on the next one.
 */

import { realpathSync } from 'node:fs';
import { homedir as nodeHomedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Thrown by the scaffold writers when asked to set up a project at `$HOME`.
 * Callers that own a user-facing surface (the CLI's `ok init`, the desktop
 * dialogs) catch it to render a clean refusal; everything else propagates.
 */
export class HomeProjectRootError extends Error {
  /** The offending directory, as resolved by the writer that refused. */
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      `Refusing to set up an OpenKnowledge project in your home directory (${projectRoot}).\n` +
        `  A project here would run 'git init' in your home directory and write project config\n` +
        `  and skills into your editors' user-global directories (~/.cursor, ~/.codex, ~/.claude).\n` +
        `  Make a folder for this project, then run 'ok init' inside it.`,
    );
    this.name = 'HomeProjectRootError';
    this.projectRoot = projectRoot;
  }
}

/**
 * Canonicalize so two spellings of the same directory compare equal.
 *
 * `realpathSync.native` rather than `realpathSync`: on Windows the 8.3 alias
 * (`C:\Users\RUNNER~1` for `C:\Users\runneradmin`) is a different string that no
 * separator normalization reconciles, and only the native binding expands it.
 * The operands here arrive by different routes — one from a user-supplied path
 * or a folder picker, the other from `os.homedir()` — so the alias mismatch is
 * reachable. Best-effort: falls back to the input when the path cannot be
 * resolved (a not-yet-created directory resolves to itself, which is correct
 * for this comparison).
 *
 * Exported because the CLI's `resolve-project-root` and the desktop's
 * `folder-admission` need the identical comparison for their own ancestor
 * walks. They used to carry byte-identical copies kept in sync by drift
 * comments; the server package is below both in the dependency graph, so one
 * export lets TypeScript catch what the comments only asked for politely.
 */
export function canonicalizeForCompare(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** `dir` IS the home directory (any spelling of it). */
export function isHomeDir(dir: string, home: string = nodeHomedir()): boolean {
  return canonicalizeForCompare(resolve(dir)) === canonicalizeForCompare(home);
}

/**
 * Throw `HomeProjectRootError` when `dir` is the home directory. Call BEFORE
 * any filesystem side effect, so a refusal leaves nothing behind.
 */
export function assertNotHomeProjectRoot(dir: string, home?: string): void {
  if (isHomeDir(dir, home)) throw new HomeProjectRootError(resolve(dir));
}
