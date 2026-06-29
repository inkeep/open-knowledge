import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveBundledSkillDir } from '@inkeep/open-knowledge-server';
import type { EditorId, EditorMcpTarget } from '../commands/editors.ts';


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
