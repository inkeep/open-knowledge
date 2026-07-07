/**
 * Project-local Agent Skill installer + the path-safety guard it relies on.
 *
 * Both `ok init` and the desktop project-setup path
 * (`writeProjectAiIntegrations`) install the project-level runtime skill
 * through this one shared implementation.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveBundledSkillDir } from '@inkeep/open-knowledge-server';
import type { EditorId, EditorMcpTarget } from '../commands/editors.ts';

// ---------------------------------------------------------------------------
// Project-scope write safety
// ---------------------------------------------------------------------------

/**
 * Guard against project-scope writes that would traverse a symbolic link.
 * Without this check `writeFileSync` and `mkdirSync` follow symlinks, so a
 * pre-existing `.mcp.json -> /etc/passwd` (or similar) planted in a cloned
 * repository would silently overwrite the target file when the user runs
 * `ok init` inside that directory.
 *
 * Refuses two distinct cases:
 *   1. The target path itself is a symbolic link — refuse regardless of
 *      where it points; project-scope writes never traverse a symlink at
 *      the leaf.
 *   2. The deepest existing ancestor of the target resolves (via realpath)
 *      outside the project directory — this catches symlinked parent
 *      directories such as `.cursor -> /etc` whose contents would be
 *      written into the symlink target rather than the project tree.
 *
 * Allows the legitimate case where intermediate symlinks stay contained
 * inside the project directory.
 *
 * Scope: project-scope writes only. User-scope writes intentionally still
 * follow symlinks because users frequently maintain dotfiles repositories
 * with `~/.cursor/mcp.json` (and friends) symlinked to a managed location.
 */
export function assertProjectPathSafe(targetPath: string, cwd: string): void {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = resolve(cwd);
  }

  let leafStat: ReturnType<typeof lstatSync> | undefined;
  try {
    leafStat = lstatSync(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (leafStat?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write through a symbolic link at ${targetPath}. ` +
        'Remove the symlink and re-run project setup.',
    );
  }

  let cursor = dirname(targetPath);
  while (cursor.length > 1 && cursor !== sep) {
    let cursorRealpath: string;
    try {
      cursorRealpath = realpathSync(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cursor = dirname(cursor);
        continue;
      }
      throw err;
    }
    const rel = relative(realCwd, cursorRealpath);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
    throw new Error(
      `Refusing to write at ${targetPath}: ancestor ${cursor} resolves to ${cursorRealpath}, ` +
        `which is outside the project directory ${realCwd}. A symbolic link in the path likely ` +
        'escapes the project. Remove the symlink and re-run project setup.',
    );
  }
}

// ---------------------------------------------------------------------------
// Project-local skill writer
// ---------------------------------------------------------------------------

export interface ProjectSkillResult {
  readonly editorId: EditorId;
  readonly label: string;
  readonly action: 'written' | 'overwritten' | 'skipped-unsupported' | 'failed';
  readonly path: string;
  readonly error?: string;
}

export function writeProjectSkill(target: EditorMcpTarget, cwd: string): ProjectSkillResult {
  const skillPath = target.projectSkillPath?.(cwd);
  if (!skillPath) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'skipped-unsupported',
      path: '',
    };
  }

  try {
    // The rich `project` bundle — `name: open-knowledge` — installs
    // project-local. checkDesktop:true so a co-installed OK Desktop's
    // (possibly newer) bundled assets win.
    const sourceDir = resolveBundledSkillDir('project', { checkDesktop: true });
    const targetDir = dirname(skillPath);
    // Refuse before `rmSync(targetDir)` runs — without this, a symlinked
    // ancestor (e.g. `.claude -> /etc`) would route the recursive removal +
    // copy through the symlink target.
    assertProjectPathSafe(targetDir, cwd);
    const action = existsSync(skillPath) ? 'overwritten' : 'written';
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true });
    return {
      editorId: target.id,
      label: target.label,
      action,
      path: skillPath,
    };
  } catch (err) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'failed',
      path: skillPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
