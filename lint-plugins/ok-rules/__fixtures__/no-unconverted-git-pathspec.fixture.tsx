// FIXTURE — drives `no-unconverted-git-pathspec.test.ts` via shell-out to `pnpm exec oxlint`. Not
// part of the main lint: `__fixtures__/` is in `oxlint.config.ts#ignorePatterns`, and
// `__fixtures__/oxlint.fixtures.json` re-enables the rules for the test.
//
// Pairs 5 positive cases (rule MUST fire) with negative cases (rule must NOT fire). Every positive
// is a real pre-fix argv from PRD-8638 rather than a synthetic one: the bug supplied them.
//
// The negatives are the precision boundary, not clean code. Four are the verbs whose `--` operands
// genuinely are not pathspecs (`hash-object` takes file arguments, `clone` takes a URL and a
// directory, `worktree add` takes a commit-ish, `mv` takes literal source and destination paths) —
// these prove the in-rule allowlist works from any position in the argv and through a nested
// conditional tail. Two are `parse-command.ts`'s string comparisons against the `--` token, which
// are not argv construction at all and are the shape most likely to draw a widened pattern.
//
// The fixture test asserts the diagnostic count with exact equality (`toBe(7)`) so both a weakened
// pattern (drops below 7) and a widened pattern that catches a negative (rises above 7) fail the
// gate.
//
// P6 and P7 pin the two fail-open holes an earlier position-blind predicate had: it exempted an
// argv as soon as ANY collected string matched an allowlisted verb, from any position, and it
// merged an array-of-argvs into one bag so one allowlisted row disarmed its siblings.
declare const batch: readonly string[];
declare const chunk: readonly string[];
declare const p: string;
declare const rel: string;
declare const branch: string;
declare const worktreePath: string;
declare const baseBranch: string | undefined;
declare const docPath: string | undefined;
declare const url: string;
declare const tmp: string;
declare const arg: string;
declare const value: string;
declare const git: { raw(...args: unknown[]): Promise<string> };
declare function execFileSync(cmd: string, args: readonly string[]): string;
declare function execFileAsync(cmd: string, args: readonly string[]): Promise<string>;
declare function listNames(g: typeof git, args: readonly string[]): Promise<string[]>;
declare function pathspecArgs(paths: readonly string[]): string[];

async function positives() {
  // P1: the diagnosed line at sync-engine.ts:2766, verbatim.
  await git.raw(['add', '--', ...batch]);
  // P2: the CLI tracked-path probe at git-exclude.ts:260.
  execFileSync('git', ['ls-files', '--error-unmatch', '--', p]);
  // P3: the varargs form at skill-reimport.ts:214.
  await git.raw('ls-files', '--', rel);
  // P4: a conditional tail (timeline-query.ts:551). One diagnostic on the outer argv, not two.
  await git.raw(['log', '--format=%H', ...(docPath ? ['--', docPath] : [])]);
  // P5: the multiline array form (sync-engine.ts:1106).
  await listNames(git, ['diff', '--cached', '--name-only', '--', ...batch]);
  // P6: an allowlisted verb appearing as a PATH operand must not exempt the argv it sits in.
  await git.raw(['add', '--', 'worktree']);
  // P7: an array of argvs. The `add` row fires; the `worktree` row beside it stays exempt, and
  // does not disarm its sibling.
  const rows = [
    ['add', '--', p],
    ['worktree', 'add', worktreePath, '--', branch],
  ];
  return rows;
}

async function negatives() {
  // N1: `hash-object` takes file arguments, in the varargs form (shadow-repo.ts:1289).
  await git.raw('hash-object', '-w', '--', ...chunk);
  // N2: `clone` takes a URL and a directory, and is not the first element (fetch.ts:114).
  await execFileAsync('git', ['-c', 'core.symlinks=false', 'clone', '-q', '--', url, tmp]);
  // N3: `worktree add` takes a commit-ish (worktree-service.ts:240).
  const added = ['worktree', 'add', worktreePath, '--', branch];
  // N4: the same, with the separator in a nested conditional tail (worktree-service.ts:237).
  const created = [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    ...(baseBranch ? ['--', baseBranch] : []),
  ];
  // N5: `git mv` takes literal path arguments, not pathspecs (api-extension.ts:1412). Verified
  // against real git 2.49.0: `git mv -- ':(literal):colon.md' moved.md` reports
  // `fatal: bad source, source=:(literal):colon.md, destination=moved.md`, so converting this
  // operand would break the case-only rename it implements.
  await git.raw('mv', '--', p, rel);
  // N6: a string comparison against the token, not argv construction (parse-command.ts:55).
  const isFlag = arg.startsWith('--');
  // N7: an equality test against the token (parse-command.ts:220).
  const isSeparator = value === '--';
  // N8: the converted shape the fix installs.
  await git.raw(['add', ...pathspecArgs([...batch])]);
  // N9: flags that merely begin with the separator's characters.
  const flags = ['diff', '--name-only', '--cached'];
  return { added, created, isFlag, isSeparator, flags };
}

export { negatives, positives };
