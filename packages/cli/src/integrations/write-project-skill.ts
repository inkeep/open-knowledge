/**
 * Project-local Agent Skill installer + the path-safety guard it relies on.
 *
 * Both `ok init` and the desktop project-setup path
 * (`writeProjectAiIntegrations`) install the project-level runtime skill
 * through this one shared implementation.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveBundledSkillDir } from '@inkeep/open-knowledge-server';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
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

  assertProjectAncestorsContained(targetPath, cwd);
}

/**
 * The removal-side counterpart of `assertProjectPathSafe`. A symlink AT the
 * target path is fine here — removal unlinks the link itself and never touches
 * what it points to, and OK's own skill projections are installed as symlinks
 * (see `projectSkill` in `@inkeep/open-knowledge-server`), so refusing leaf
 * symlinks would strand OK's own footprint on `ok deinit`. The ancestor check
 * still applies: a symlinked parent (`.claude -> /etc`) would route a recursive
 * removal outside the project tree.
 */
export function assertProjectRemovalSafe(targetPath: string, cwd: string): void {
  assertProjectAncestorsContained(targetPath, cwd);
}

function assertProjectAncestorsContained(targetPath: string, cwd: string): void {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = resolve(cwd);
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
  readonly action:
    | 'written'
    | 'overwritten'
    | 'skipped-unsupported'
    | 'skipped-prerequisite'
    | 'failed';
  readonly path: string;
  readonly error?: string;
}

export interface ProjectSkillWriteOptions {
  readonly home?: string;
}

const MCP_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configHasOpenKnowledgeEntry(
  target: EditorMcpTarget,
  cwd: string,
  configPath: string,
): boolean {
  try {
    if (statSync(configPath).size > MCP_CONFIG_MAX_BYTES) return false;
  } catch {
    return false;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return false;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(parsed)) return false;

  const topLevel = parsed[target.topLevelKey];
  if (!isRecord(topLevel)) return false;
  const serverMap = target.serverMapSubKey ? topLevel[target.serverMapSubKey] : topLevel;
  if (!isRecord(serverMap)) return false;
  return isRecord(serverMap[target.serverName(cwd)]);
}

/**
 * Copilot loads OK's runtime skill from the project but its MCP registration
 * from user-global config. Shared project MCP wiring belongs to other hosts and
 * cannot satisfy Copilot's prerequisite.
 */
function isProjectSkillPrerequisiteMet(
  target: EditorMcpTarget,
  cwd: string,
  options: ProjectSkillWriteOptions = {},
): boolean {
  if (target.id !== 'copilot') return true;

  try {
    return configHasOpenKnowledgeEntry(target, cwd, target.configPath(cwd, options.home));
  } catch {
    return false;
  }
}

export function writeProjectSkill(
  target: EditorMcpTarget,
  cwd: string,
  options: ProjectSkillWriteOptions = {},
): ProjectSkillResult {
  const skillPath = target.projectSkillPath?.(cwd);
  if (!skillPath) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'skipped-unsupported',
      path: '',
    };
  }
  if (!isProjectSkillPrerequisiteMet(target, cwd, options)) {
    return {
      editorId: target.id,
      label: target.label,
      action: 'skipped-prerequisite',
      path: skillPath,
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

// ---------------------------------------------------------------------------
// Project-local skill uninstaller
// ---------------------------------------------------------------------------

export interface ProjectSkillRemoveResult {
  readonly editorId: EditorId;
  readonly label: string;
  readonly action: 'removed' | 'not-present' | 'skipped-unsupported' | 'failed';
  readonly path: string;
  readonly error?: string;
}

/**
 * Targeted uninstall of the project-local runtime skill — the reverse of
 * `writeProjectSkill`, for the Settings-driven per-component toggle.
 *
 * OpenKnowledge owns the whole `<host>/skills/open-knowledge/` directory (the
 * write path `cpSync`s the bundle into it wholesale), so removal is
 * whole-directory. The presence of the managed `SKILL.md` at
 * `projectSkillPath` is the ownership marker: a directory at the managed path
 * WITHOUT it is not something OK authored and is left untouched
 * (`not-present`). The removal-side guard runs before the `rmSync`, so a
 * symlinked ancestor (`.claude -> /etc`) can never route the recursive
 * removal outside the project tree — while a symlink AT the path (a skill
 * projection) is still removable.
 */
export function removeProjectSkill(target: EditorMcpTarget, cwd: string): ProjectSkillRemoveResult {
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
    const targetDir = dirname(skillPath);
    // No managed SKILL.md at the path → nothing of ours to remove. Idempotent
    // re-run and "a foreign directory squatting the name" both land here.
    if (!existsSync(skillPath)) {
      return {
        editorId: target.id,
        label: target.label,
        action: 'not-present',
        path: skillPath,
      };
    }
    // Refuse escaping ancestors before `rmSync` runs; a leaf symlink is fine
    // to unlink on the removal side.
    assertProjectRemovalSafe(targetDir, cwd);
    rmSync(targetDir, { recursive: true, force: true });
    return {
      editorId: target.id,
      label: target.label,
      action: 'removed',
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
