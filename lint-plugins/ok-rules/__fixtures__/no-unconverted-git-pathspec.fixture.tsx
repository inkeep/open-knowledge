// FIXTURE — drives `no-unconverted-git-pathspec.test.ts` via shell-out to `pnpm exec oxlint`. Not
// part of the main lint: `__fixtures__/` is in `oxlint.config.ts#ignorePatterns`, and
// `__fixtures__/oxlint.fixtures.json` re-enables the rules for the test.
//
// Pairs 7 positive cases (rule MUST fire) with negative cases (rule must NOT fire). P1-P5 are real
// pre-fix argv from PRD-8638 rather than synthetic ones: the bug supplied them. P6 and P7 are
// constructed; the closing paragraph says what they pin.
//
// The negatives are the precision boundary, not clean code. Six cover the five verbs whose `--`
// operands genuinely are not pathspecs (`hash-object` takes file arguments, `clone` takes a URL and
// a directory, `worktree add` takes a commit-ish, `mv` takes literal source and destination paths,
// `update-index` takes literal file names) — these prove the in-rule allowlist works from any
// position in the argv and through a nested conditional tail. Two are `parse-command.ts`'s string
// comparisons against the `--` token, which are not argv construction at all and are the shape most
// likely to draw a widened pattern.
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
  // N1: `hash-object` takes file arguments, in the varargs form (shadow-repo.ts#parkBranchInner).
  await git.raw('hash-object', '-w', '--', ...chunk);
  // N2: `clone` takes a URL and a directory, and is not the first element (fetch.ts#fetchSource).
  await execFileAsync('git', ['-c', 'core.symlinks=false', 'clone', '-q', '--', url, tmp]);
  // N3: `worktree add` takes a commit-ish (worktree-service.ts#buildAddArgs).
  const added = ['worktree', 'add', worktreePath, '--', branch];
  // N4: the same, with the separator in a nested conditional tail
  // (worktree-service.ts#buildAddArgs).
  const created = [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    ...(baseBranch ? ['--', baseBranch] : []),
  ];
  // N5: `git mv` takes literal path arguments, not pathspecs
  // (api-extension.ts#renameTrackedPathInGit, which carries four calls of this shape). Verified
  // against real git 2.49.0: `git mv -- ':(literal):colon.md' moved.md` reports
  // `fatal: bad source, source=:(literal):colon.md, destination=moved.md`, so converting this
  // operand would break the case-only rename it implements.
  await git.raw('mv', '--', p, rel);
  // N6: `update-index` takes literal file names, in the varargs form
  // (shadow-repo.ts#dropExcludedIndexEntries).
  await git.raw('update-index', '--force-remove', '--', ...chunk);
  // N7: a string comparison against the token, not argv construction
  // (parse-command.ts#isRecursiveGrepFlag).
  const isFlag = arg.startsWith('--');
  // N8: an equality test against the token (parse-command.ts#classifyArgs).
  const isSeparator = value === '--';
  // N9: the converted shape the fix installs.
  await git.raw(['add', ...pathspecArgs([...batch])]);
  // N10: flags that merely begin with the separator's characters.
  const flags = ['diff', '--name-only', '--cached'];
  return { added, created, isFlag, isSeparator, flags };
}

export { negatives, positives };
