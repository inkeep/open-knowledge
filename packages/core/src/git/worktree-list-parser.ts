export interface BridgeWorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
}

const REFS_HEADS_PREFIX = 'refs/heads/';

export function parseWorktreeListPorcelain(stdout: string): BridgeWorktreeEntry[] {
  if (stdout.length === 0) return [];

  const entries: BridgeWorktreeEntry[] = [];
  let current: MutableEntry | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (line.length === 0) {
      if (current !== null) {
        const finalized = finalizeBlock(current);
        if (finalized !== null) entries.push(finalized);
        current = null;
      }
      continue;
    }

    const sepIndex = line.indexOf(' ');
    const key = sepIndex === -1 ? line : line.slice(0, sepIndex);
    const value = sepIndex === -1 ? '' : line.slice(sepIndex + 1);

    if (key === 'worktree') {
      if (current !== null) {
        const finalized = finalizeBlock(current);
        if (finalized !== null) entries.push(finalized);
      }
      current = value.length > 0 ? createBlock(value) : null;
      continue;
    }

    if (current === null) continue;

    switch (key) {
      case 'HEAD':
        current.headSha = value.length > 0 ? value : null;
        break;
      case 'branch':
        current.branch = stripRefsHeads(value);
        break;
      case 'detached':
        current.branch = null;
        current.detached = true;
        break;
      case 'locked':
        current.locked = true;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      default:
        break;
    }
  }

  if (current !== null) {
    const finalized = finalizeBlock(current);
    if (finalized !== null) entries.push(finalized);
  }

  return entries;
}

interface MutableEntry {
  path: string;
  branch: string | null;
  headSha: string | null;
  locked: boolean;
  prunable: boolean;
  detached: boolean;
}

function createBlock(path: string): MutableEntry {
  return { path, branch: null, headSha: null, locked: false, prunable: false, detached: false };
}

function finalizeBlock(block: MutableEntry): BridgeWorktreeEntry | null {
  if (block.path.length === 0) return null;
  return {
    path: block.path,
    branch: block.branch,
    headSha: block.headSha,
    locked: block.locked,
    prunable: block.prunable,
  };
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith(REFS_HEADS_PREFIX) ? ref.slice(REFS_HEADS_PREFIX.length) : ref;
}
