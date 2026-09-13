import { OK_DIR, WORKTREES_DIRNAME } from '../constants/ok-dir.ts';

export const WORKTREES_PARENT_DIR = `${OK_DIR}/${WORKTREES_DIRNAME}`;

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
