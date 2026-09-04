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
import { USER_MCP_GATED_EDITOR_IDS } from '@inkeep/open-knowledge-core';
import { resolveBundledSkillDir } from '@inkeep/open-knowledge-server';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import type { EditorId, EditorMcpTarget } from '../commands/editors.ts';

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

function isProjectSkillPrerequisiteMet(
  target: EditorMcpTarget,
  cwd: string,
  options: ProjectSkillWriteOptions = {},
): boolean {
  if (!USER_MCP_GATED_EDITOR_IDS.includes(target.id)) return true;

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
    const sourceDir = resolveBundledSkillDir('project', { checkDesktop: true });
    const targetDir = dirname(skillPath);
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

export interface ProjectSkillRemoveResult {
  readonly editorId: EditorId;
  readonly label: string;
  readonly action: 'removed' | 'not-present' | 'skipped-unsupported' | 'failed';
  readonly path: string;
  readonly error?: string;
}

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
    if (!existsSync(skillPath)) {
      return {
        editorId: target.id,
        label: target.label,
        action: 'not-present',
        path: skillPath,
      };
    }
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
