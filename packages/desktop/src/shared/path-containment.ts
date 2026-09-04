import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

function isContainablePath(path: string, platform: NodeJS.Platform): boolean {
  if (!path || typeof path !== 'string' || path.includes('\0')) return false;
  if (platform === 'win32') return /^([a-zA-Z]:[\\/]|\\\\)/.test(path);
  return path.startsWith('/');
}

export function validateSpawnPath(path: string, platform: NodeJS.Platform): boolean {
  if (!isContainablePath(path, platform)) return false;
  return platform !== 'win32' || !/["%]/.test(path);
}

export function isPathWithinProject(
  userPath: string,
  projectPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (!isContainablePath(userPath, platform)) return false;
  if (!isContainablePath(projectPath, platform)) return false;
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  try {
    const canonicalUser = p.resolve(userPath);
    const canonicalProject = p.resolve(projectPath);
    if (platform === 'win32') {
      const userRoot = p.parse(canonicalUser).root.toLowerCase();
      const projectRoot = p.parse(canonicalProject).root.toLowerCase();
      if (!userRoot || !projectRoot || userRoot !== projectRoot) return false;
    }
    if (canonicalUser === canonicalProject) return true;
    const rel = p.relative(canonicalProject, canonicalUser);
    if (rel === '' || rel === '.') return true;
    if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
    if (platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\'))) {
      return false;
    }
    if (platform !== 'win32' && rel.startsWith('/')) return false;
    return true;
  } catch (err) {
    console.warn('[path-containment] unexpected path-resolution error:', err);
    return false;
  }
}
