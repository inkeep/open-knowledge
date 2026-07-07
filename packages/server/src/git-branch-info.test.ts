import { afterEach, describe, expect, test } from 'bun:test';

import {
  computeBranchInfo,
  isBranchResolutionError,
  isValidBranchInfoPath,
  isValidBranchName,
} from './git-branch-info.ts';
import { createGitTriangle, type GitTriangle } from './share/git-fixture.test-helper.ts';

describe('isValidBranchName', () => {
  test('accepts a plain branch name', () => {
    expect(isValidBranchName('main')).toBe(true);
  });

  test('accepts a namespaced branch name with forward-slashes', () => {
    expect(isValidBranchName('feat/foo')).toBe(true);
  });

  test('rejects a leading dash (flag injection)', () => {
    expect(isValidBranchName('-evil')).toBe(false);
  });

  test('rejects leading whitespace', () => {
    expect(isValidBranchName(' main')).toBe(false);
  });

  test('rejects trailing whitespace', () => {
    expect(isValidBranchName('main ')).toBe(false);
  });

  test('rejects control characters', () => {
    expect(isValidBranchName('main\nfoo')).toBe(false);
    expect(isValidBranchName('main\x00foo')).toBe(false);
  });

  test('rejects non-string inputs', () => {
    expect(isValidBranchName(null)).toBe(false);
    expect(isValidBranchName(undefined)).toBe(false);
    expect(isValidBranchName(123)).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidBranchName('')).toBe(false);
  });

  test('rejects colon (refspec injection: HEAD:refs/heads/evil)', () => {
    // git fetch origin <branch> interprets `:` as the refspec separator —
    // a branch like `HEAD:refs/heads/evil` would otherwise survive the gate
    // and rewrite local refs from attacker-controlled share URLs.
    expect(isValidBranchName('HEAD:refs/heads/evil')).toBe(false);
    expect(isValidBranchName('foo:bar')).toBe(false);
  });

  test('rejects `..` segment (symmetric with CheckoutRequestSchema)', () => {
    expect(isValidBranchName('feat/../escape')).toBe(false);
    expect(isValidBranchName('..')).toBe(false);
  });
});

describe('isValidBranchInfoPath', () => {
  test('accepts a single-segment doc path', () => {
    expect(isValidBranchInfoPath('README.md', 'doc')).toBe(true);
  });

  test('accepts a nested forward-slash doc path', () => {
    expect(isValidBranchInfoPath('docs/sub/page.md', 'doc')).toBe(true);
  });

  test('rejects a leading forward-slash (absolute path)', () => {
    expect(isValidBranchInfoPath('/etc/passwd', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('/etc/passwd', 'folder')).toBe(false);
  });

  test('rejects any backslash — wire contract is forward-slash only', () => {
    // A `\`-bearing docPath from a hostile share URL would otherwise survive
    // the gate and reach `git cat-file -e <ref>:<docPath>` with an anomalous
    // ref-spec. Tightens the asymmetry with `buildGitHubBlobUrl` (which
    // splits on `/` only).
    expect(isValidBranchInfoPath('docs\\page.md', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('\\etc\\passwd', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('foo/bar\\baz.md', 'folder')).toBe(false);
  });

  test('rejects `..` traversal segment', () => {
    expect(isValidBranchInfoPath('docs/../etc/passwd', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('docs/../etc/passwd', 'folder')).toBe(false);
  });

  test('rejects `.git` segment (exact match, not `.gitignore`)', () => {
    expect(isValidBranchInfoPath('.git/HEAD', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('foo/.git/config', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('.gitignore', 'doc')).toBe(true);
    expect(isValidBranchInfoPath('.github/foo.md', 'doc')).toBe(true);
  });

  test('rejects consecutive slashes (empty segment)', () => {
    expect(isValidBranchInfoPath('docs//page.md', 'doc')).toBe(false);
  });

  test('rejects control characters', () => {
    expect(isValidBranchInfoPath('docs/\npage.md', 'doc')).toBe(false);
    expect(isValidBranchInfoPath('docs/\x00.md', 'doc')).toBe(false);
  });

  test('rejects non-string inputs', () => {
    expect(isValidBranchInfoPath(null, 'doc')).toBe(false);
    expect(isValidBranchInfoPath(undefined, 'doc')).toBe(false);
    expect(isValidBranchInfoPath(123, 'doc')).toBe(false);
  });

  test('empty string is the folder-root sentinel: valid for folder, invalid for doc', () => {
    expect(isValidBranchInfoPath('', 'folder')).toBe(true);
    expect(isValidBranchInfoPath('', 'doc')).toBe(false);
  });

  test('non-empty folder path passes the same segment gate as doc', () => {
    expect(isValidBranchInfoPath('docs/guides', 'folder')).toBe(true);
    expect(isValidBranchInfoPath('docs', 'folder')).toBe(true);
  });
});

describe('isBranchResolutionError', () => {
  test('matches simple-git "unknown revision" failure (target ref not local)', () => {
    expect(
      isBranchResolutionError(
        new Error(
          "fatal: ambiguous argument 'HEAD..feat/missing': unknown revision or path not in the working tree.",
        ),
      ),
    ).toBe(true);
  });

  test('matches simple-git "bad revision" failure', () => {
    expect(isBranchResolutionError(new Error("fatal: bad revision 'HEAD..feat/missing'"))).toBe(
      true,
    );
  });

  test('matches the bare "ambiguous argument" form', () => {
    expect(isBranchResolutionError(new Error('fatal: ambiguous argument HEAD..foo'))).toBe(true);
  });

  test('rejects disk I/O failures (EACCES on .git/index)', () => {
    // real I/O errors must NOT be swallowed as
    // "no conflict, branch isn't local" — they should propagate (or at
    // minimum log loudly) so the operator sees the actual problem.
    expect(
      isBranchResolutionError(
        new Error('error: cannot open .git/index: Permission denied (EACCES)'),
      ),
    ).toBe(false);
  });

  test('rejects git-binary-missing failures', () => {
    expect(isBranchResolutionError(new Error('spawn git ENOENT'))).toBe(false);
  });

  test('rejects "not a git repository" failures', () => {
    expect(
      isBranchResolutionError(new Error('fatal: not a git repository (or any parent up)')),
    ).toBe(false);
  });

  test('handles non-Error throwables', () => {
    expect(isBranchResolutionError('fatal: unknown revision HEAD..foo')).toBe(true);
    expect(isBranchResolutionError('random string')).toBe(false);
    expect(isBranchResolutionError(null)).toBe(false);
    expect(isBranchResolutionError(undefined)).toBe(false);
  });
});

describe('computeBranchInfo — shareTargetOnOriginBranch (network-free hint)', () => {
  const triangles: GitTriangle[] = [];
  function newTriangle(): GitTriangle {
    const t = createGitTriangle();
    triangles.push(t);
    return t;
  }
  afterEach(() => {
    for (const t of triangles.splice(0)) t.cleanup();
  });

  test('true when the target exists at origin/<branch>', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', '# hi\n');
    const info = await computeBranchInfo(t.senderDir, t.branch, 'doc.md', 'doc');
    expect(info.shareTargetOnOriginBranch).toBe(true);
  });

  test('false when the target is missing on an existing origin ref', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', '# hi\n');
    const info = await computeBranchInfo(t.senderDir, t.branch, 'gone.md', 'doc');
    expect(info.shareTargetOnOriginBranch).toBe(false);
  });

  test('reads the origin ref, not HEAD: a committed-but-unpushed doc is false', async () => {
    const t = newTriangle();
    // Committed locally but never pushed — HEAD has it, origin/<branch> does not.
    t.commitWithoutPush('local-only.md', '# local\n');
    const info = await computeBranchInfo(t.senderDir, t.branch, 'local-only.md', 'doc');
    expect(info.shareTargetOnOriginBranch).toBe(false);
  });

  test('undefined when the origin ref is not present locally (unknown until a fetch)', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', '# hi\n');
    const info = await computeBranchInfo(t.senderDir, 'never-fetched-branch', 'doc.md', 'doc');
    expect(info.shareTargetOnOriginBranch).toBeUndefined();
  });

  test('folder content root is always present on the ref (true)', async () => {
    const t = newTriangle();
    const info = await computeBranchInfo(t.senderDir, t.branch, '', 'folder');
    expect(info.shareTargetOnOriginBranch).toBe(true);
  });
});
