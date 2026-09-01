export function parseBranchList(stdout: string): string[] {
  if (stdout.length === 0) return [];

  const seen = new Set<string>();
  const branches: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const branch = rawLine.replace(/\r$/, '').trim();
    if (branch.length === 0 || seen.has(branch)) continue;
    seen.add(branch);
    branches.push(branch);
  }
  return branches;
}
