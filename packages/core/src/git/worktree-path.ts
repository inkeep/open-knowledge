export const WORKTREES_PARENT_DIR = '.ok/worktrees';

export function worktreeRelativeDir(branch: string): string | null {
  const trimmed = branch.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return null;
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg.length === 0 || seg === '.' || seg === '..') return null;
    if (seg.includes('\\') || seg.includes('\0')) return null;
  }
  return `${WORKTREES_PARENT_DIR}/${trimmed}`;
}
