import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

// The server keeps an independent sibling at its package boundary; the desktop
// parity matrix pins both implementations to the same lexical verdicts.

function isContainablePath(path: string, platform: NodeJS.Platform): boolean {
  if (!path || typeof path !== 'string' || path.includes('\0')) return false;
  if (platform === 'win32') return /^([a-zA-Z]:[\\/]|\\\\)/.test(path);
  return path.startsWith('/');
}

/** Reject path forms that cannot safely pass through the Windows spawn shell. */
export function validateSpawnPath(path: string, platform: NodeJS.Platform): boolean {
  if (!isContainablePath(path, platform)) return false;
  // `%` expands inside cmd.exe double quotes, while `"` cannot be quoted.
  return platform !== 'win32' || !/["%]/.test(path);
}

/**
 * Lexically verify that `userPath` lies at or below `projectPath`. Callers at a
 * filesystem trust boundary must realpath first so an admitted symlink cannot
 * escape after this check.
 */
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
    // This shared module stays dependency-free so main and utility processes
    // can use identical containment semantics without pulling in pino.
    console.warn('[path-containment] unexpected path-resolution error:', err);
    return false;
  }
}
