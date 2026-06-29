import { statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export type CheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

function isSafeProjectPath(projectPath: string): boolean {
  if (typeof projectPath !== 'string') return false;
  if (projectPath.length === 0) return false;
  if (projectPath.includes('\0')) return false;
  if (!isAbsolute(projectPath)) return false;
  if (resolve(projectPath) !== projectPath) return false;
  return true;
}

function isSafeTargetPath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.length === 0) return false;
  if (isAbsolute(path)) return false;
  if (path.includes('\\')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '..' || s === '.git')) return false;
  return true;
}

function joinContained(projectPath: string, path: string): string | null {
  const joined = resolve(join(projectPath, path));
  const projectResolved = resolve(projectPath);
  const projectWithSep = projectResolved.endsWith(sep) ? projectResolved : projectResolved + sep;
  if (joined === projectResolved) return joined;
  if (!joined.startsWith(projectWithSep)) return null;
  return joined;
}

export function checkTargetExists(
  projectPath: string,
  kind: 'doc' | 'folder',
  path: string,
): CheckTargetExistsResult {
  if (!isSafeProjectPath(projectPath)) return 'unreadable';
  if (!isSafeTargetPath(path)) return 'unreadable';
  const fullPath = joinContained(projectPath, path);
  if (fullPath === null) return 'unreadable';
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(fullPath);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return 'missing';
    }
    return 'unreadable';
  }
  const matches = kind === 'folder' ? stat.isDirectory() : stat.isFile();
  if (!matches) return 'missing';
  return 'exists';
}
