import { describe, expect, test } from 'bun:test';
import {
  BranchInfoResponseSchema,
  type ClassifiedGitAuthError,
  classifyGitAuthError,
  isBranchNotFoundGitError,
  isLoginFixableGitAuthError,
  isValidBranchName,
  ShareConstructUrlResponseSchema,
  ShareFreshnessSchema,
  ShareTargetStatusRequestSchema,
  ShareTargetStatusResponseSchema,
  ShareTargetStatusVerdictSchema,
} from './share.ts';

function withGitStderr(message: string, stderr: string): Error & { git: string } {
  const err = new Error(message) as Error & { git: string };
  err.git = stderr;
  return err;
}

describe('classifyGitAuthError', () => {
  test('returns non-auth for null / undefined', () => {
    expect(classifyGitAuthError(null)).toEqual({ kind: 'non-auth' });
    expect(classifyGitAuthError(undefined)).toEqual({ kind: 'non-auth' });
  });

  test('returns non-auth for branch-not-found', () => {
    expect(
      classifyGitAuthError(new Error("fatal: couldn't find remote ref refs/heads/feat-x")),
    ).toEqual({ kind: 'non-auth' });
  });

  test('returns non-auth for network errors', () => {
    expect(classifyGitAuthError(new Error('could not resolve host github.com'))).toEqual({
      kind: 'non-auth',
    });
    expect(classifyGitAuthError(new Error('connection timed out'))).toEqual({ kind: 'non-auth' });
  });

  test('classifies "could not read Username" as no-credential (GIT_TERMINAL_PROMPT=0 case)', () => {
    expect(
      classifyGitAuthError(new Error('fatal: could not read Username for https://github.com')),
    ).toEqual({ kind: 'auth', subclass: 'no-credential' });
  });

  test('classifies "could not read Password" as no-credential', () => {
    expect(
      classifyGitAuthError(new Error('fatal: could not read Password for https://github.com')),
    ).toEqual({ kind: 'auth', subclass: 'no-credential' });
  });

  test('classifies "terminal prompts disabled" as no-credential', () => {
    expect(classifyGitAuthError(new Error('fatal: terminal prompts disabled'))).toEqual({
      kind: 'auth',
      subclass: 'no-credential',
    });
  });

  test('classifies HTTP 401 as 401', () => {
    expect(classifyGitAuthError(new Error('remote: HTTP 401 Unauthorized'))).toEqual({
      kind: 'auth',
      subclass: '401',
    });
  });

  test('classifies forward "token ... expired" as 401 (expired-token folds into 401)', () => {
    expect(classifyGitAuthError(new Error('GitHub token has expired'))).toEqual({
      kind: 'auth',
      subclass: '401',
    });
  });

  test('classifies reversed "expired token" as unknown-auth, not 401', () => {
    // Reversed wording is auth but not 401 — mirrors the server 401 discriminator
    // (forward-only) so the delegated classifyGitError output stays unchanged.
    expect(classifyGitAuthError(new Error('expired token'))).toEqual({
      kind: 'auth',
      subclass: 'unknown-auth',
    });
  });

  test('classifies HTTP 403 as 403', () => {
    expect(classifyGitAuthError(new Error('remote: HTTP 403 Forbidden'))).toEqual({
      kind: 'auth',
      subclass: '403',
    });
  });

  test('classifies "insufficient scopes" as scope-mismatch', () => {
    expect(classifyGitAuthError(new Error('insufficient scopes — required: repo'))).toEqual({
      kind: 'auth',
      subclass: 'scope-mismatch',
    });
  });

  test('classifies "missing scope" as scope-mismatch', () => {
    expect(classifyGitAuthError(new Error('GitHub token missing required scope: repo'))).toEqual({
      kind: 'auth',
      subclass: 'scope-mismatch',
    });
  });

  test('classifies "Authentication failed" as unknown-auth (no 401/403)', () => {
    expect(classifyGitAuthError(new Error('remote: Authentication failed'))).toEqual({
      kind: 'auth',
      subclass: 'unknown-auth',
    });
  });

  test('classifies "Bad credentials" as unknown-auth (no 401/403)', () => {
    expect(classifyGitAuthError(new Error('remote: Bad credentials'))).toEqual({
      kind: 'auth',
      subclass: 'unknown-auth',
    });
  });

  test('classifies SSH publickey denied as ssh-auth (not login-fixable)', () => {
    expect(classifyGitAuthError(new Error('Permission denied (publickey).'))).toEqual({
      kind: 'auth',
      subclass: 'ssh-auth',
    });
  });

  test('classifies host key verification failed as ssh-auth (not login-fixable)', () => {
    expect(classifyGitAuthError(new Error('Host key verification failed.'))).toEqual({
      kind: 'auth',
      subclass: 'ssh-auth',
    });
  });

  test('classifies "fatal: repository not found" as unknown-auth (private-repo masquerade)', () => {
    expect(
      classifyGitAuthError(new Error("fatal: repository 'https://github.com/o/r.git' not found")),
    ).toEqual({ kind: 'auth', subclass: 'unknown-auth' });
  });

  test('reads stderr from simple-git-style { message, git } shape', () => {
    expect(
      classifyGitAuthError(
        withGitStderr('Clone failed', 'fatal: could not read Username for https://github.com'),
      ),
    ).toEqual({ kind: 'auth', subclass: 'no-credential' });
  });

  test('accepts plain string inputs', () => {
    expect(classifyGitAuthError('HTTP 403 Forbidden')).toEqual({
      kind: 'auth',
      subclass: '403',
    });
    expect(classifyGitAuthError('happy path output')).toEqual({ kind: 'non-auth' });
  });

  test('no-credential takes priority over an incidental 401 substring', () => {
    expect(
      classifyGitAuthError(
        new Error(
          'fatal: could not read Username for https://github.com\nremote: HTTP 401 Unauthorized',
        ),
      ),
    ).toEqual({ kind: 'auth', subclass: 'no-credential' });
  });

  test('scope-mismatch takes priority over an incidental 403', () => {
    expect(classifyGitAuthError(new Error('insufficient scopes\nHTTP 403 Forbidden'))).toEqual({
      kind: 'auth',
      subclass: 'scope-mismatch',
    });
  });
});

describe('isLoginFixableGitAuthError', () => {
  const cases: ReadonlyArray<{ input: ClassifiedGitAuthError; expected: boolean }> = [
    { input: { kind: 'auth', subclass: 'no-credential' }, expected: true },
    { input: { kind: 'auth', subclass: '401' }, expected: true },
    { input: { kind: 'auth', subclass: 'unknown-auth' }, expected: true },
    { input: { kind: 'auth', subclass: '403' }, expected: false },
    { input: { kind: 'auth', subclass: 'scope-mismatch' }, expected: false },
    { input: { kind: 'auth', subclass: 'ssh-auth' }, expected: false },
    { input: { kind: 'non-auth' }, expected: false },
  ];

  for (const { input, expected } of cases) {
    const label = input.kind === 'auth' ? `auth/${input.subclass}` : 'non-auth';
    test(`${label} → ${expected}`, () => {
      expect(isLoginFixableGitAuthError(input)).toBe(expected);
    });
  }
});

describe('isValidBranchName', () => {
  // The single source of truth for share/clone branch validity — 7 security
  // rules with named threats in its JSDoc. Pure predicate; no mocking needed.
  test('accepts a plain branch', () => expect(isValidBranchName('main')).toBe(true));
  test('accepts a slashed namespaced branch', () =>
    expect(isValidBranchName('feat/foo')).toBe(true));
  test('accepts dots within a segment (not a `..` segment)', () =>
    expect(isValidBranchName('feat..ure')).toBe(true));

  test('rejects a non-string', () => {
    expect(isValidBranchName(null)).toBe(false);
    expect(isValidBranchName(undefined)).toBe(false);
    expect(isValidBranchName(42)).toBe(false);
  });
  test('rejects an empty string', () => expect(isValidBranchName('')).toBe(false));
  test('rejects a leading dash (git flag injection)', () => {
    expect(isValidBranchName('-rf')).toBe(false);
    expect(isValidBranchName('--upload-pack=evil')).toBe(false);
  });
  test('rejects control characters', () => {
    expect(isValidBranchName(`main${String.fromCharCode(0)}evil`)).toBe(false);
    expect(isValidBranchName(`main${String.fromCharCode(7)}bell`)).toBe(false);
  });
  test('rejects whitespace', () => {
    expect(isValidBranchName('feat ure')).toBe(false);
    expect(isValidBranchName('feat\ture')).toBe(false);
  });
  test('rejects a colon (refspec-separator injection)', () =>
    expect(isValidBranchName('HEAD:refs/heads/evil')).toBe(false));
  test('rejects a `..` path-traversal segment', () => {
    expect(isValidBranchName('feat/../evil')).toBe(false);
    expect(isValidBranchName('../evil')).toBe(false);
  });
});

describe('isBranchNotFoundGitError', () => {
  test('matches the "couldn\'t find remote ref" variants (case-insensitive)', () => {
    expect(
      isBranchNotFoundGitError(new Error("fatal: couldn't find remote ref refs/heads/x")),
    ).toBe(true);
    expect(
      isBranchNotFoundGitError(new Error("fatal: Couldn't find remote ref refs/heads/x")),
    ).toBe(true);
  });
  test('matches the older "Remote branch ... not found" format', () =>
    expect(
      isBranchNotFoundGitError(new Error('Remote branch feat-x not found in upstream origin')),
    ).toBe(true));
  test('does not match other git failures (auth / network / nullish)', () => {
    expect(isBranchNotFoundGitError(new Error('remote: HTTP 403 Forbidden'))).toBe(false);
    expect(isBranchNotFoundGitError(new Error('could not resolve host github.com'))).toBe(false);
    expect(isBranchNotFoundGitError(null)).toBe(false);
    expect(isBranchNotFoundGitError(undefined)).toBe(false);
  });
});

describe('ShareFreshnessSchema (closed v1 enum)', () => {
  test('accepts the three v1 freshness states', () => {
    for (const value of ['current', 'stale', 'absent'] as const) {
      expect(ShareFreshnessSchema.parse(value)).toBe(value);
    }
  });

  test('rejects a value outside the closed enum', () => {
    expect(ShareFreshnessSchema.safeParse('unpushed').success).toBe(false);
    expect(ShareFreshnessSchema.safeParse('').success).toBe(false);
    expect(ShareFreshnessSchema.safeParse(null).success).toBe(false);
  });
});

describe('ShareConstructUrlResponseSchema freshness field', () => {
  const successBase = {
    ok: true,
    shareUrl: 'https://openknowledge.ai/d/abc',
    sharedUrl: 'https://github.com/o/r/blob/main/doc.md',
    branch: 'main',
  };

  test('a success response without freshness still parses (additive optional)', () => {
    const parsed = ShareConstructUrlResponseSchema.parse({ ...successBase });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.freshness).toBeUndefined();
  });

  test('each valid freshness value round-trips on the success variant', () => {
    for (const value of ['current', 'stale', 'absent'] as const) {
      const parsed = ShareConstructUrlResponseSchema.parse({ ...successBase, freshness: value });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.freshness).toBe(value);
    }
  });

  test('an unknown freshness value is treated as omitted, not a parse failure', () => {
    // Value-level forward-compat: a newer server may emit a freshness state
    // this client's enum predates; the share must still parse, minus the
    // warning it can't interpret.
    const result = ShareConstructUrlResponseSchema.safeParse({
      ...successBase,
      freshness: 'catching-up',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.ok) {
      expect(result.data.freshness).toBeUndefined();
    }
  });

  test('a non-string freshness value is tolerated as omitted', () => {
    for (const bad of [null, 42, {}, ['stale']]) {
      const result = ShareConstructUrlResponseSchema.safeParse({ ...successBase, freshness: bad });
      expect(result.success).toBe(true);
      if (result.success && result.data.ok) {
        expect(result.data.freshness).toBeUndefined();
      }
    }
  });

  test('the error variant still gates on the unchanged error-code enum', () => {
    expect(
      ShareConstructUrlResponseSchema.safeParse({ ok: false, error: 'no-remote' }).success,
    ).toBe(true);
    expect(
      ShareConstructUrlResponseSchema.safeParse({ ok: false, error: 'invalid-path' }).success,
    ).toBe(true);
    // A freshness value is not an error code — adding `freshness` never
    // widened the error enum.
    expect(ShareConstructUrlResponseSchema.safeParse({ ok: false, error: 'stale' }).success).toBe(
      false,
    );
    expect(ShareConstructUrlResponseSchema.safeParse({ ok: false, error: 'bogus' }).success).toBe(
      false,
    );
  });
});

describe('ShareTargetStatusVerdictSchema (closed v1 enum)', () => {
  test('accepts the six v1 verdicts', () => {
    for (const v of [
      'on-origin',
      'renamed',
      'deleted',
      'never-on-branch',
      'changed-locally',
      'unknown',
    ] as const) {
      expect(ShareTargetStatusVerdictSchema.parse(v)).toBe(v);
    }
  });

  test('rejects a value outside the closed enum', () => {
    expect(ShareTargetStatusVerdictSchema.safeParse('moved').success).toBe(false);
    expect(ShareTargetStatusVerdictSchema.safeParse('').success).toBe(false);
  });
});

describe('ShareTargetStatusRequestSchema', () => {
  test('accepts a well-formed doc request', () => {
    expect(
      ShareTargetStatusRequestSchema.safeParse({ branch: 'main', path: 'doc.md', kind: 'doc' })
        .success,
    ).toBe(true);
  });

  test('accepts an empty path for a folder (content root)', () => {
    expect(
      ShareTargetStatusRequestSchema.safeParse({ branch: 'main', path: '', kind: 'folder' })
        .success,
    ).toBe(true);
  });

  test('rejects an unsafe branch name (refspec injection)', () => {
    expect(
      ShareTargetStatusRequestSchema.safeParse({
        branch: 'HEAD:refs/heads/evil',
        path: 'doc.md',
        kind: 'doc',
      }).success,
    ).toBe(false);
  });

  test('rejects a missing or invalid kind', () => {
    expect(
      ShareTargetStatusRequestSchema.safeParse({ branch: 'main', path: 'doc.md' }).success,
    ).toBe(false);
    expect(
      ShareTargetStatusRequestSchema.safeParse({ branch: 'main', path: 'doc.md', kind: 'blob' })
        .success,
    ).toBe(false);
  });
});

describe('ShareTargetStatusResponseSchema (value-tolerant verdict union)', () => {
  test('parses each destination-free verdict', () => {
    for (const verdict of [
      'on-origin',
      'deleted',
      'never-on-branch',
      'changed-locally',
      'unknown',
    ] as const) {
      expect(ShareTargetStatusResponseSchema.parse({ verdict }).verdict).toBe(verdict);
    }
  });

  test('renamed carries its verified renamedTo destination', () => {
    const parsed = ShareTargetStatusResponseSchema.parse({
      verdict: 'renamed',
      renamedTo: 'knowledge/a.md',
    });
    expect(parsed.verdict).toBe('renamed');
    if (parsed.verdict === 'renamed') expect(parsed.renamedTo).toBe('knowledge/a.md');
  });

  test('a renamed verdict missing renamedTo degrades to unknown (no illegal state)', () => {
    expect(ShareTargetStatusResponseSchema.parse({ verdict: 'renamed' }).verdict).toBe('unknown');
  });

  test('an unrecognized verdict value degrades to unknown, not a parse failure', () => {
    const result = ShareTargetStatusResponseSchema.safeParse({ verdict: 'moved' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.verdict).toBe('unknown');
  });

  test('a non-object or nullish body degrades to unknown', () => {
    for (const bad of [null, undefined, 42, 'renamed', {}]) {
      const result = ShareTargetStatusResponseSchema.safeParse(bad);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.verdict).toBe('unknown');
    }
  });
});

describe('BranchInfoResponseSchema shareTargetOnOriginBranch field', () => {
  const base = {
    detached: false,
    currentBranch: 'main',
    currentHeadSha: null,
    shareTargetExists: true,
    dirtyConflicts: { conflicts: false, files: [] },
    branchIsLocal: true,
  };

  test('an existing response without the field still parses (additive optional)', () => {
    const parsed = BranchInfoResponseSchema.parse({ ...base });
    if (!parsed.detached) expect(parsed.shareTargetOnOriginBranch).toBeUndefined();
  });

  test('the hint parses when present (true or false)', () => {
    for (const hint of [true, false]) {
      const parsed = BranchInfoResponseSchema.parse({ ...base, shareTargetOnOriginBranch: hint });
      if (!parsed.detached) expect(parsed.shareTargetOnOriginBranch).toBe(hint);
    }
  });
});
