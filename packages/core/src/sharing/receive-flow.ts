export interface HeadBranchInfo {
  readonly currentBranch: string | null;
  readonly headSha: string | null;
  readonly detached: boolean;
}

export type ResolvedGitDirKind =
  | 'directory'
  | 'linked'
  | 'absent'
  | 'malformed-pointer'
  | 'inaccessible';

export interface RecentProjectEntry {
  path: string;
  name: string;
  lastOpenedAt: string;
  missing?: boolean;
  gitRemoteUrl?: string;
}

export interface ExpectedShareRepo {
  readonly owner: string;
  readonly repo: string;
}

export function canonicalGitHubRemoteUrl(expected: ExpectedShareRepo): string {
  return `https://github.com/${expected.owner}/${expected.repo}.git`;
}

function normalizeForMatch(url: string): string {
  let normalized = url.toLowerCase().trim();
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized.endsWith('.git')) normalized = normalized.slice(0, -4);
  return normalized;
}

export function findRecentProjectsForRepo(
  recents: readonly RecentProjectEntry[],
  expected: ExpectedShareRepo,
): RecentProjectEntry[] {
  const target = normalizeForMatch(canonicalGitHubRemoteUrl(expected));
  const matches: RecentProjectEntry[] = [];
  for (const entry of recents) {
    if (entry.missing === true) continue;
    if (!entry.gitRemoteUrl) continue;
    if (normalizeForMatch(entry.gitRemoteUrl) === target) matches.push(entry);
  }
  return matches;
}

export type BranchMatchOutcome = 'true' | 'false' | 'detached';

export function classifyBranchMatch(
  shareBranch: string | null | undefined,
  head: HeadBranchInfo,
): BranchMatchOutcome {
  if (!shareBranch || shareBranch.length === 0) return 'true';
  if (head.detached) return 'detached';
  if (head.currentBranch === null) return 'true';
  return head.currentBranch === shareBranch ? 'true' : 'false';
}
