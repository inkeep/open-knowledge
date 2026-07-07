import { describe, expect, test } from 'bun:test';
import { classifyGitError, deriveUserFacingCode } from './error-classification.ts';

function mkErr(message: string, stderr?: string): Error {
  const err = new Error(message);
  if (stderr !== undefined) {
    (err as unknown as Record<string, string>).git = stderr;
  }
  return err;
}

describe('classifyGitError', () => {
  describe('Class 1 — Network (retryable)', () => {
    test('DNS resolution failure', () => {
      const r = classifyGitError(
        mkErr('fatal: unable to access', 'Could not resolve host: github.com'),
      );
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('dns');
      expect(r.retryable).toBe(true);
    });

    test('ENOTFOUND from Node', () => {
      const r = classifyGitError(mkErr('getaddrinfo ENOTFOUND github.com'));
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('dns');
      expect(r.retryable).toBe(true);
    });

    test('connection timeout', () => {
      const r = classifyGitError(mkErr('Connection timed out'));
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('timeout');
      expect(r.retryable).toBe(true);
    });

    test('connection refused', () => {
      const r = classifyGitError(mkErr('ECONNREFUSED 127.0.0.1:22'));
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('connection-refused');
      expect(r.retryable).toBe(true);
    });

    test('HTTP 5xx error', () => {
      const r = classifyGitError(mkErr('fatal: repository', 'error 503 Service Unavailable'));
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('5xx');
      expect(r.retryable).toBe(true);
    });

    test('HTTP 429 rate limit', () => {
      const r = classifyGitError(mkErr('push failed: 429 Too Many Requests'));
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('429');
      expect(r.retryable).toBe(true);
    });

    test('rate limit by keyword', () => {
      const r = classifyGitError(mkErr('remote: rate limit exceeded'));
      expect(r.class).toBe('network');
      expect(r.subclass).toBe('429');
      expect(r.retryable).toBe(true);
    });
  });

  describe('Class 2 — Auth (non-retryable)', () => {
    test('authentication failed', () => {
      const r = classifyGitError(mkErr('Authentication failed for remote'));
      expect(r.class).toBe('auth');
      expect(r.retryable).toBe(false);
    });

    test('401 status in stderr', () => {
      const r = classifyGitError(mkErr('remote error', 'HTTP 401 Unauthorized'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('401');
      expect(r.retryable).toBe(false);
    });

    test('403 without branch protection → auth', () => {
      const r = classifyGitError(mkErr('remote: HTTP 403 Forbidden'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('403');
      expect(r.retryable).toBe(false);
    });

    test('bad credentials', () => {
      const r = classifyGitError(mkErr('remote: Bad credentials'));
      expect(r.class).toBe('auth');
      expect(r.retryable).toBe(false);
    });

    test('expired token', () => {
      const r = classifyGitError(mkErr('fatal: token expired'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('401');
      expect(r.retryable).toBe(false);
    });

    test('reversed "expired token" wording → unknown-auth, not 401 (delegation preserves output)', () => {
      const r = classifyGitError(mkErr('expired token'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('unknown-auth');
      expect(r.retryable).toBe(false);
    });

    test('permission denied (publickey)', () => {
      const r = classifyGitError(mkErr('Permission denied (publickey).'));
      expect(r.class).toBe('auth');
      expect(r.retryable).toBe(false);
    });

    test('scope mismatch', () => {
      const r = classifyGitError(mkErr('insufficient scopes for this operation'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('scope-mismatch');
      expect(r.retryable).toBe(false);
    });

    // No-credential: the credential helper returned nothing and git fell back to
    // a no-TTY prompt. Must classify as auth (non-retryable) so the UI offers
    // reconnect rather than looping in a retryable "offline" state.
    test('no credential — "could not read Username … Device not configured" (no GIT_TERMINAL_PROMPT)', () => {
      const r = classifyGitError(
        mkErr(
          'fatal: could not read Username',
          "fatal: could not read Username for 'https://github.com': Device not configured",
        ),
      );
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('no-credential');
      expect(r.retryable).toBe(false);
      expect(r.userFacingCode).toBe('auth-no-credential');
    });

    test('no credential — "terminal prompts disabled" (with GIT_TERMINAL_PROMPT=0)', () => {
      const r = classifyGitError(
        mkErr(
          'fatal: could not read Username',
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        ),
      );
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('no-credential');
      expect(r.retryable).toBe(false);
      expect(r.userFacingCode).toBe('auth-no-credential');
    });

    test('no credential — could not read Password', () => {
      const r = classifyGitError(
        mkErr(
          'fatal',
          "could not read Password for 'https://github.com': terminal prompts disabled",
        ),
      );
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('no-credential');
    });

    test('deriveUserFacingCode maps auth/no-credential', () => {
      expect(deriveUserFacingCode('auth', 'no-credential')).toBe('auth-no-credential');
    });

    test('unknown-auth subclass — "Authentication failed" without 401/403 signal', () => {
      const r = classifyGitError(mkErr('Authentication failed for remote'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('unknown-auth');
      expect(r.retryable).toBe(false);
      expect(r.message).toBe('Authentication failed');
    });

    test('unknown-auth subclass — bad credentials without 401/403 signal', () => {
      const r = classifyGitError(mkErr('remote: Bad credentials'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('unknown-auth');
    });

    test('ssh-auth subclass — SSH publickey denied (delegation preserves output)', () => {
      const r = classifyGitError(mkErr('Permission denied (publickey).'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('ssh-auth');
      expect(r.retryable).toBe(false);
      expect(r.message).toBe('SSH authentication failed — check your SSH key or host-key trust');
    });

    test('ssh-auth subclass — host key verification failed', () => {
      const r = classifyGitError(mkErr('Host key verification failed.'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('ssh-auth');
    });
  });

  describe('Class 3 — Semantic (non-retryable)', () => {
    test('non-fast-forward rejection', () => {
      const r = classifyGitError(
        mkErr(
          '[rejected] main -> main (non-fast-forward)',
          'error: failed to push some refs\nhint: Updates were rejected',
        ),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('non-fast-forward');
      expect(r.retryable).toBe(false);
    });

    test('updates were rejected (non-FF variant)', () => {
      const r = classifyGitError(mkErr('updates were rejected'));
      expect(r.class).toBe('semantic');
      expect(r.retryable).toBe(false);
    });

    test('protected branch', () => {
      const r = classifyGitError(
        mkErr('remote: error: protected branch', 'protected branch hook declined'),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('protected-branch');
      expect(r.retryable).toBe(false);
    });

    test('GitHub branch protection GH002', () => {
      const r = classifyGitError(
        mkErr('remote: GH002 – The main branch of this repository requires a pull request'),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('protected-branch');
      expect(r.retryable).toBe(false);
    });

    test('at least N approving reviews required', () => {
      const r = classifyGitError(mkErr('remote: At least 2 approving review is required'));
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('protected-branch');
      expect(r.retryable).toBe(false);
    });

    test('403 with protected branch keywords → semantic', () => {
      const r = classifyGitError(mkErr('remote: 403 Forbidden – protected branch'));
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('protected-branch');
      expect(r.retryable).toBe(false);
    });

    test('automatic merge failed → merge conflict', () => {
      const r = classifyGitError(
        mkErr('Automatic merge failed; fix conflicts and then commit the result.'),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('merge-conflict');
      expect(r.retryable).toBe(false);
    });

    test('CONFLICT keyword', () => {
      const r = classifyGitError(mkErr('CONFLICT (content): Merge conflict in src/file.ts'));
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('merge-conflict');
      expect(r.retryable).toBe(false);
    });

    test('simple-git GitResponseError shape (CONFLICTS: file:reason)', () => {
      // Mirrors the actual error simple-git throws from `git.merge()` when
      // conflicts occur: `new GitResponseError(MergeSummaryDetail)` produces
      // `message = "CONFLICTS: <file>:<reason>[, …]"` and `git` is the
      // MergeSummaryDetail object whose toString() yields the same string.
      const mergeSummary = {
        conflicts: [{ file: 'test.md', reason: 'content' }],
        merges: [],
        result: 'success',
        failed: true,
        toString() {
          return 'CONFLICTS: test.md:content';
        },
      };
      const err = new Error('CONFLICTS: test.md:content');
      (err as unknown as Record<string, unknown>).git = mergeSummary;
      const r = classifyGitError(err);
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('merge-conflict');
      expect(r.retryable).toBe(false);
    });
  });

  describe('Class 4 — Structural (non-retryable)', () => {
    test('LFS quota exceeded', () => {
      const r = classifyGitError(mkErr('remote: error: LFS storage quota exceeded'));
      expect(r.class).toBe('structural');
      expect(r.subclass).toBe('lfs-quota');
      expect(r.retryable).toBe(false);
    });

    test('file too large', () => {
      const r = classifyGitError(mkErr('remote: file exceeds 100 MB push file size limit'));
      expect(r.class).toBe('structural');
      expect(r.subclass).toBe('large-file');
      expect(r.retryable).toBe(false);
    });

    test('pre-receive hook decline', () => {
      const r = classifyGitError(mkErr('remote: pre-receive hook declined'));
      expect(r.class).toBe('structural');
      expect(r.subclass).toBe('pre-receive-hook');
      expect(r.retryable).toBe(false);
    });

    test('secret detected', () => {
      const r = classifyGitError(mkErr('remote: Push blocked — secret detected in commit'));
      expect(r.class).toBe('structural');
      expect(r.subclass).toBe('secret-detected');
      expect(r.retryable).toBe(false);
    });

    test('secret scanning', () => {
      const r = classifyGitError(mkErr('remote: Secret scanning found credentials in push'));
      expect(r.class).toBe('structural');
      expect(r.subclass).toBe('secret-detected');
      expect(r.retryable).toBe(false);
    });
  });

  describe('Class 5 — Local (retryable)', () => {
    test('index.lock', () => {
      const r = classifyGitError(mkErr("fatal: Unable to create '.git/index.lock': File exists."));
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('index-lock');
      expect(r.retryable).toBe(true);
    });

    test('another git process', () => {
      const r = classifyGitError(
        mkErr('fatal: Another git process seems to be running in this repository'),
      );
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('index-lock');
      expect(r.retryable).toBe(true);
    });

    test('dirty working tree', () => {
      const r = classifyGitError(
        mkErr('error: Your local changes to the following files would be overwritten by merge'),
      );
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('dirty-tree');
      expect(r.retryable).toBe(true);
    });

    test('please commit or stash', () => {
      const r = classifyGitError(
        mkErr('Please commit your changes or stash them before you merge'),
      );
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('dirty-tree');
      expect(r.retryable).toBe(true);
    });

    test('disk full', () => {
      const r = classifyGitError(mkErr('error: no space left on device'));
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('disk-full');
      expect(r.retryable).toBe(true);
    });

    test('bare ENOSPC (case-insensitive, no "no space left" text to fall back on)', () => {
      // Regression: /ENOSPC/ (no /i) was matched against a lowercased string,
      // so it never fired — only the sibling /no space left on device/i did.
      const r = classifyGitError(mkErr('fatal: write error: ENOSPC'));
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('disk-full');
      expect(r.retryable).toBe(true);
    });

    test('non-Error input falls back to local', () => {
      const r = classifyGitError('unexpected git error');
      expect(r.class).toBe('local');
      expect(r.retryable).toBe(true);
    });
  });

  describe('ClassifiedError shape', () => {
    test('includes message string', () => {
      const r = classifyGitError(mkErr('ENOTFOUND github.com'));
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
    });

    test('rawStderr is optional but included when available', () => {
      const r = classifyGitError(mkErr('fatal', 'stderr content here'));
      // rawStderr may or may not be populated depending on classification path
      if (r.rawStderr !== undefined) {
        expect(typeof r.rawStderr).toBe('string');
      }
    });

    test('retryable is a boolean', () => {
      const r = classifyGitError(mkErr('anything'));
      expect(typeof r.retryable).toBe('boolean');
    });
  });

  describe('userFacingCode — bounded enum for UI Lingui mapping', () => {
    test('auth/403 → auth-403 code', () => {
      const r = classifyGitError(
        mkErr(
          'fatal: Authentication failed',
          'remote: Permission to inkeep/foo.git denied. HTTP 403',
        ),
      );
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('403');
      expect(r.userFacingCode).toBe('auth-403');
    });

    test('auth/401 → auth-401 code', () => {
      const r = classifyGitError(mkErr('Authentication failed: HTTP 401'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('401');
      expect(r.userFacingCode).toBe('auth-401');
    });

    test('auth/scope-mismatch → auth-scope-mismatch code', () => {
      const r = classifyGitError(mkErr('error: missing required scope: repo'));
      expect(r.class).toBe('auth');
      expect(r.subclass).toBe('scope-mismatch');
      expect(r.userFacingCode).toBe('auth-scope-mismatch');
    });

    test('semantic/protected-branch (via GH006) → semantic-protected-branch code', () => {
      const r = classifyGitError(
        mkErr('error: failed to push', 'remote: error: GH006: Protected branch update failed'),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('protected-branch');
      expect(r.userFacingCode).toBe('semantic-protected-branch');
    });

    test('semantic/protected-branch (via 403 + keywords) → semantic-protected-branch code', () => {
      const r = classifyGitError(
        mkErr('error: failed', 'HTTP 403: protected branch refusing to allow non-fast-forward'),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('protected-branch');
      expect(r.userFacingCode).toBe('semantic-protected-branch');
    });

    test('semantic/non-fast-forward → null (UI falls back to message)', () => {
      const r = classifyGitError(
        mkErr('error: failed to push some refs', 'rejected non-fast-forward updates'),
      );
      expect(r.class).toBe('semantic');
      expect(r.subclass).toBe('non-fast-forward');
      expect(r.userFacingCode).toBeNull();
    });

    test('semantic/merge-conflict → null', () => {
      const r = classifyGitError(mkErr('CONFLICT (content): Merge conflict in foo.md'));
      expect(r.class).toBe('semantic');
      expect(r.userFacingCode).toBeNull();
    });

    test('network/dns → null', () => {
      const r = classifyGitError(mkErr('getaddrinfo ENOTFOUND github.com'));
      expect(r.class).toBe('network');
      expect(r.userFacingCode).toBeNull();
    });

    test('local/index-lock → null', () => {
      const r = classifyGitError(mkErr('Unable to create .git/index.lock'));
      expect(r.class).toBe('local');
      expect(r.userFacingCode).toBeNull();
    });

    test('structural/secret-detected → null', () => {
      const r = classifyGitError(mkErr('remote: error: secret detected'));
      expect(r.class).toBe('structural');
      expect(r.userFacingCode).toBeNull();
    });

    test('local fallback (unknown error) → null', () => {
      const r = classifyGitError(mkErr('totally unrecognized git failure'));
      expect(r.class).toBe('local');
      expect(r.subclass).toBe('unknown-local');
      expect(r.userFacingCode).toBeNull();
    });

    test('userFacingCode is either a bounded enum value or null on every classification', () => {
      const validCodes = new Set([
        'auth-403',
        'auth-401',
        'auth-scope-mismatch',
        'auth-no-credential',
        'semantic-protected-branch',
      ]);
      const samples = [
        mkErr('Could not resolve host: github.com'),
        mkErr('HTTP 403: forbidden'),
        mkErr("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
        mkErr('CONFLICT'),
        mkErr('lfs storage quota exceeded'),
        mkErr('Unknown error'),
      ];
      for (const e of samples) {
        const r = classifyGitError(e);
        if (r.userFacingCode !== null) {
          expect(validCodes.has(r.userFacingCode)).toBe(true);
        }
      }
    });

    test('the wire never carries English in the code path', () => {
      // Belt-and-braces guard: anyone scanning the code field across every
      // classification result must see only the bounded enum values (no raw
      // sentence ever slips through). Localization lives entirely client-side.
      const r403 = classifyGitError(mkErr('HTTP 403: Permission denied'));
      expect(typeof r403.userFacingCode === 'string').toBe(true);
      expect(r403.userFacingCode).not.toMatch(/permission to push/i);
      expect(r403.userFacingCode).not.toMatch(/^\w+\s/); // no whitespace = no sentence
    });
  });

  describe('deriveUserFacingCode — pure helper', () => {
    test('maps the four named buckets to their codes', () => {
      expect(deriveUserFacingCode('auth', '403')).toBe('auth-403');
      expect(deriveUserFacingCode('auth', '401')).toBe('auth-401');
      expect(deriveUserFacingCode('auth', 'scope-mismatch')).toBe('auth-scope-mismatch');
      expect(deriveUserFacingCode('semantic', 'protected-branch')).toBe(
        'semantic-protected-branch',
      );
    });

    test('returns null for any other (class, subclass) tuple', () => {
      expect(deriveUserFacingCode('network', 'dns')).toBeNull();
      expect(deriveUserFacingCode('auth', 'unknown-auth')).toBeNull();
      expect(deriveUserFacingCode('semantic', 'merge-conflict')).toBeNull();
      expect(deriveUserFacingCode('local', 'index-lock')).toBeNull();
      expect(deriveUserFacingCode('structural', 'lfs-quota')).toBeNull();
    });
  });
});
