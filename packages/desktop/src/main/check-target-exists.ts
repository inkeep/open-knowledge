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

export function checkProjectDirExists(projectPath: string): CheckTargetExistsResult {
  if (!isSafeProjectPath(projectPath)) return 'unreadable';
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(projectPath);
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
  return stat.isDirectory() ? 'exists' : 'missing';
}

export function computeShareTargetMissing(
  probe: (projectPath: string, kind: 'doc' | 'folder', path: string) => CheckTargetExistsResult,
  projectPath: string,
  target: { kind: 'doc' | 'folder'; path: string },
): boolean {
  if (target.kind === 'folder' && target.path === '') return false;
  return probe(projectPath, target.kind, target.path) === 'missing';
}

type ShareProbeLogger = { warn(obj: object, msg: string): void };

export function resolveShareProbeRoot(
  projectPath: string,
  readContentDir: (projectPath: string) => string,
  log?: ShareProbeLogger,
): string {
  if (!isSafeProjectPath(projectPath)) return projectPath;
  try {
    const candidate = resolve(projectPath, readContentDir(projectPath));
    const projectWithSep = projectPath.endsWith(sep) ? projectPath : projectPath + sep;
    return candidate === projectPath || candidate.startsWith(projectWithSep)
      ? candidate
      : projectPath;
  } catch (err) {
    log?.warn(
      { errorKind: err instanceof Error ? err.name : typeof err },
      '[receive] content.dir resolution failed — probing the project root',
    );
    return projectPath;
  }
}

export function resolveTargetProbeCoordinate(
  projectPath: string,
  target: { kind: 'doc' | 'folder'; path: string; repositoryPath?: string },
  readContentDir: (projectPath: string) => string,
  log?: ShareProbeLogger,
): { root: string; target: { kind: 'doc' | 'folder'; path: string } } {
  if (target.repositoryPath !== undefined) {
    return { root: projectPath, target: { kind: target.kind, path: target.repositoryPath } };
  }
  return {
    root: resolveShareProbeRoot(projectPath, readContentDir, log),
    target: { kind: target.kind, path: target.path },
  };
}
