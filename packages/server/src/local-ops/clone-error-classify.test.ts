
import { describe, expect, test } from 'bun:test';
import { classifyCloneError } from './clone-error-classify.ts';

const TITLE_NO_ACCESS_404 =
  "Can't access this repository. It may be private, or you may not have access.";
const TITLE_NO_ACCESS_403 = "You don't have access to this repository.";
const TITLE_AUTH = 'GitHub authentication failed. Try signing in again.';
const TITLE_GENERIC = 'Clone subprocess reported an error.';

describe('classifyCloneError', () => {
  describe('access-class git stderr → access-specific title', () => {
    test('"Repository not found" (404 — private or missing) → access-specific title', () => {
      const stderr =
        "remote: Repository not found.\nfatal: repository 'https://github.com/acme/private-repo.git/' not found";
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_404);
      expect(result.detail).toContain('Repository not found');
    });

    test('"fatal: ... 404" → access-specific title', () => {
      const stderr =
        "fatal: unable to access 'https://github.com/acme/x.git/': The requested URL returned error: 404";
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_404);
      expect(result.detail).toContain('404');
    });

    test('"Permission denied" (403 — explicit access denial) → access-specific title', () => {
      const stderr = 'remote: Permission denied to alice.\nfatal: unable to access ...';
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_403);
      expect(result.detail).toContain('Permission denied');
    });

    test('"access denied" (enterprise/org phrasing) → access-specific title', () => {
      const stderr = 'remote: access denied for principal://alice@acme.example';
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_403);
      expect(result.detail).toContain('access denied');
    });

    test('"error: 403" / unable to access → access-specific title', () => {
      const stderr =
        "fatal: unable to access 'https://github.com/acme/x.git/': The requested URL returned error: 403";
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_403);
      expect(result.detail).toContain('403');
    });

    test('"Authentication failed" → auth-specific title', () => {
      const stderr =
        "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/x.git/'";
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_AUTH);
      expect(result.detail).toContain('Authentication failed');
    });
  });

  describe('priority ordering (404 wins over auth when both phrases co-occur)', () => {
    test('"Repository not found" + "Authentication failed" stderr → 404 title (404 wins)', () => {
      const stderr =
        "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/acme/x.git/'";
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_404);
    });

    test('"Permission denied" + "Authentication failed" stderr → 403 title (403 wins)', () => {
      const stderr = 'remote: Permission denied.\nfatal: Authentication failed';
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_403);
    });
  });

  describe('generic stderr → preserves stderr in detail, keeps generic title', () => {
    test('unrecognized stderr → detail populated, generic title', () => {
      const stderr = 'fatal: unable to update url base from redirection: warp drive offline';
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_GENERIC);
      expect(result.detail).toContain('warp drive offline');
      expect(result.detail.length).toBeGreaterThan(0);
    });
  });

  describe('PAT / credential redaction (detail is wire-shipped + logged)', () => {
    test('x-access-token PAT in URL is redacted in detail', () => {
      const stderr =
        "fatal: unable to access 'https://x-access-token:ghp_abc123XYZ@github.com/acme/x.git/': 404";
      const result = classifyCloneError(stderr);
      expect(result.detail).not.toContain('ghp_abc123XYZ');
      expect(result.detail).toContain('***');
    });

    test('bare basic-auth credentials in URL are redacted', () => {
      const stderr = "fatal: unable to access 'https://alice:s3cret@github.com/x.git/': 403";
      const result = classifyCloneError(stderr);
      expect(result.detail).not.toContain('s3cret');
      expect(result.detail).toContain('***');
    });
  });

  describe('length cap (toast / log hygiene)', () => {
    test('extremely long stderr → detail truncated to exactly MAX_DETAIL_LEN (500) chars from the start', () => {
      const stderr = `fatal: ${'x'.repeat(10_000)}`;
      const result = classifyCloneError(stderr);
      expect(result.detail.length).toBe(500);
      expect(result.detail.startsWith('fatal: ')).toBe(true);
    });
  });

  describe('empty / whitespace inputs', () => {
    test('empty string → detail is empty, generic title', () => {
      const result = classifyCloneError('');
      expect(result.detail).toBe('');
      expect(result.title).toBe(TITLE_GENERIC);
    });

    test('whitespace-only → detail is empty after trim, generic title', () => {
      const result = classifyCloneError('   \n  \t  ');
      expect(result.detail).toBe('');
      expect(result.title).toBe(TITLE_GENERIC);
    });
  });
});
