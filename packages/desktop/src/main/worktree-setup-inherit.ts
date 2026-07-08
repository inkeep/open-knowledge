/**
 * Seed a freshly-created worktree's OpenKnowledge project setup from the root
 * project, so opening a worktree window doesn't re-prompt the
 * "Setup OpenKnowledge in this folder?" (Shared vs Local) consent dialog. The
 * worktree inherits the root's setup SILENTLY: the same `.ok/` scaffold and
 * editor/MCP wiring a fresh setup writes, carrying the root's `content.dir` and
 * its wired-editor set, so agents/editors work in the worktree out of the box.
 *
 * Parity is exact for a shared root whose branch committed `.ok/config.yml`:
 * that committed config lands in the worktree via checkout and is inherited
 * verbatim (the seed's `writeIfMissing` never clobbers it). For a local-only
 * root (`.ok/` uncommitted), the seed reproduces the scaffold + wiring and
 * inherits `content.dir`, but hand-edited UNCOMMITTED extras that never reach
 * the branch (e.g. a customized `.okignore`, a rarely-set `appearance.theme`)
 * are not copied — those are not part of the setup flow's output either.
 *
 * ## Why the consent dialog fires without this
 * `openProject` → `discoverProject` (`folder-admission.ts`) classifies a
 * freshly-created linked worktree via the linked-worktree carveout: an
 * UN-initialized worktree (no `<worktree>/.ok/config.yml`) returns
 * `kind:'fresh'` → the consent dialog. The gate hinges on `isProjectRoot` =
 * `<worktree>/.ok/config.yml` exists as a regular file (`OK_PROJECT_MARKER`).
 * Seeding a real, valid `config.yml` here flips the carveout off: the ancestor
 * walk then classifies the worktree `managed` (projectDir === worktree) and it
 * opens silently.
 *
 * ## What is seeded, and the writers reused (no reinvention)
 *   1. `initContent(worktree, { contentDir })` — the SAME writer the consent /
 *      create-new flows use (`@inkeep/open-knowledge-server`). Writes
 *      `.ok/config.yml` + `.ok/.gitignore` + `.okignore`. `writeIfMissing`
 *      semantics mean a config.yml already checked out by the branch (shared +
 *      committed root) is NOT clobbered. `contentDir` is read from the root's
 *      `.ok/config.yml`; it is relative to the project root, so the same value
 *      is correct in the worktree (no path rewriting).
 *   2. `writeProjectAiIntegrations(worktree, editors)` — the SAME writer the
 *      consent / create-new flows use. `editors` is the set the ROOT has wired,
 *      detected from each editor's project MCP config carrying the OK sentinel.
 *      The published MCP entries and `.claude/launch.json` recipe are the
 *      resilient `/bin/sh` chain — project-path-INDEPENDENT (they resolve the
 *      runtime at spawn time and derive the project from cwd), so writing them
 *      under the worktree path IS the path adaptation.
 *
 * ## Sharing mode (shared vs local-only) is inherited for free
 * `.git/info/exclude` lives in the git COMMON dir, shared across every worktree
 * of a repo. A local-only root already excluded `.ok/`, `.okignore`, the editor
 * MCP configs, etc. (unanchored/relative patterns), so those same entries cover
 * the worktree's copies: the seeded `.ok/config.yml` and editor configs are
 * ignored → they stay UNTRACKED, and `readSharingMode(worktree)` already reads
 * `local-only`. This seed performs pure file writes and never stages anything,
 * so it cannot accidentally add the worktree's `.ok/` to the index.
 *
 * Best-effort: every failure is logged, never thrown — the worktree already
 * exists on disk, and a missing seed just falls back to the normal onboarding
 * prompt (the prior behavior). Sits beside `seedWorktreeAutoSync`
 * (`worktree-autosync-inherit.ts`) and follows the same shape.
 */

import { existsSync, readFileSync } from 'node:fs';
import { EDITOR_TARGETS, writeProjectAiIntegrations } from '@inkeep/open-knowledge';
import { ALL_EDITOR_IDS, type EditorId } from '@inkeep/open-knowledge-core';
import { initContent } from '@inkeep/open-knowledge-server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';

/**
 * Version-INDEPENDENT prefix of OK's MCP chain sentinels. Every OK MCP entry —
 * unix (`# ok-mcp-v1`, `CHAIN_VERSION_SENTINEL`) and Windows (`# ok-mcp-win-v1`,
 * `CHAIN_WIN_VERSION_SENTINEL`, both in the CLI's `editors.ts`) — embeds a line
 * starting with this prefix, verbatim, regardless of format (JSON or TOML), and
 * `# ok-mcp-win-…` also contains it, so one prefix covers both platforms.
 *
 * Deliberately keys on the PREFIX rather than the exact `-v1` sentinel (the way
 * `editorWiredForOk` in `skill-reclaim.ts` does for its own, different purpose):
 * a sentinel bump only ever appends a new suffix (`v2`, …) and never changes
 * this prefix, so detection survives a bump with no edit here. If this were
 * pinned to `-v1` and the sentinel bumped, `detectRootWiredEditors` would
 * silently return `[]` and the worktree would lose its inherited editor wiring.
 */
const OK_MCP_MARKER_PREFIX = '# ok-mcp-';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read the root project's `content.dir` from `<mainRoot>/.ok/config.yml`.
 * Returns the value only when it's a non-default (`!== '.'`), non-empty string
 * so `initContent` uncomments the `content.dir` line; otherwise `undefined`
 * (the default commented placeholder). Never throws — a missing/unparseable
 * root config yields `undefined` and the worktree gets the default scope.
 *
 * `content.dir` is relative to the project root, so the root's value is
 * correct verbatim in the worktree — no path rewriting.
 */
export function readRootContentDir(mainRoot: string): string | undefined {
  const configPath = `${mainRoot}/.ok/config.yml`;
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const content = parsed.content;
  if (!isObject(content)) return undefined;
  const dir = content.dir;
  if (typeof dir !== 'string') return undefined;
  const trimmed = dir.trim();
  return trimmed.length > 0 && trimmed !== '.' ? dir : undefined;
}

/**
 * True iff the editor's project MCP config at `configPath` exists and carries
 * an OK chain sentinel (any version). Analogous to `editorWiredForOk` in
 * `skill-reclaim.ts`. Fail-soft: an unreadable file is treated as not-wired.
 */
function editorWiredForOk(configPath: string | undefined): boolean {
  if (!configPath) return false;
  try {
    if (!existsSync(configPath)) return false;
    const bytes = readFileSync(configPath, 'utf-8');
    return bytes.includes(OK_MCP_MARKER_PREFIX);
  } catch {
    return false;
  }
}

/**
 * The set of editors the ROOT project has wired for OK — each editor whose
 * project MCP config (`EDITOR_TARGETS[id].projectConfigPath(mainRoot)`) carries
 * an OK sentinel. Editors with no project-scope surface (`claude-desktop`,
 * `openclaw`) have no `projectConfigPath` and are never returned. Order follows
 * `ALL_EDITOR_IDS`.
 */
export function detectRootWiredEditors(mainRoot: string): EditorId[] {
  const wired: EditorId[] = [];
  for (const id of ALL_EDITOR_IDS) {
    const projectConfigPath = EDITOR_TARGETS[id]?.projectConfigPath?.(mainRoot);
    if (editorWiredForOk(projectConfigPath)) wired.push(id);
  }
  return wired;
}

/**
 * Seed the new worktree's `.ok/` scaffold and editor/MCP wiring from the root
 * project, so the worktree opens `managed` (no consent dialog) with full setup
 * parity. Idempotent and best-effort — see the module docstring. Never throws.
 */
export function seedWorktreeProjectSetup(worktreePath: string, mainRoot: string): void {
  const logger = getLogger('worktree-setup');

  // 1. `.ok/config.yml` (+ `.ok/.gitignore` + `.okignore`) — the marker that
  //    suppresses the consent dialog. `writeIfMissing`, so a committed config
  //    already in the worktree is never clobbered. `initContent` can throw only
  //    via its symlink guard; contain it so wiring still gets a chance and the
  //    worktree open never fails on a seed error.
  try {
    initContent(worktreePath, { contentDir: readRootContentDir(mainRoot) });
  } catch (err) {
    logger.warn(
      { worktreePath, err: err instanceof Error ? err.message : String(err) },
      'failed to seed inherited .ok/ scaffold',
    );
  }

  // 2. Editor/MCP wiring, mirroring exactly the editors the root has wired.
  //    `writeProjectAiIntegrations` never throws; per-(editor × integration)
  //    failures land in its outcomes. Nothing to do when the root wired no
  //    project-scope editors.
  try {
    const editors = detectRootWiredEditors(mainRoot);
    if (editors.length > 0) {
      const result = writeProjectAiIntegrations(worktreePath, editors);
      const failed = result.integrations.filter((o) => o.action === 'failed');
      if (failed.length > 0) {
        logger.warn(
          { worktreePath, editors, failed: failed.map((o) => `${o.editorId}:${o.integration}`) },
          'some inherited editor integrations failed to seed',
        );
      }
    }
  } catch (err) {
    // Defensive: the orchestrator is contract-bound not to throw, but a future
    // change must never let a wiring error abort the worktree open.
    logger.warn(
      { worktreePath, err: err instanceof Error ? err.message : String(err) },
      'failed to seed inherited editor integrations',
    );
  }
}
