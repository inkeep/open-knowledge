/**
 * Unit tests for `classifyCloneError` — the pure helper that maps git
 * stderr from `runCloneSubprocess` into the `{title, detail}` shape the
 * streaming error envelope ships on the wire.
 *
 * clone from share link failed with the generic toast
 * "Clone failed: Clone subprocess reported an error.", hiding the real
 * cause (private repo / no access). Before the fix, the clone handler
 * passed git stderr as `cause` (Pino-only) but never as `detail`, so the
 * RFC 9457 envelope's `detail` was empty and the toast fell back to the
 * hardcoded title. These tests pin two contracts: (1) `detail` carries
 * sanitized stderr; (2) recognized git error shapes (404 / 403 / auth)
 * map to access-specific titles by *exact* copy — the title is the user-
 * visible fix, so test assertions use `toBe` not `toMatch`.
 */

import { describe, expect, test } from 'bun:test';
import { classifyCloneError } from './clone-error-classify.ts';

// Pin copy at the test level — if these change, the title-mapping
// contract changed too and every consumer (toast, telemetry, logs)
// should be re-considered. Importing or hardcoding inline both work;
// hardcoding here keeps the test self-contained and explicit.
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
      // The 403 regex carries an "access denied" alternative for
      // enterprise / org phrasings that don't include "Permission".
      // Without this case the alternative was untested.
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
      // Git's auth-shaped 404 can surface both phrases at once (the
      // protocol layer says "not found" while the credential layer
      // independently says "auth failed"). The helper's documented
      // ordering — 404 first, auth last — handles this correctly. If
      // the if-blocks were reordered, this case would silently mis-
      // label as auth; this test pins the order.
      const stderr =
        "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/acme/x.git/'";
      const result = classifyCloneError(stderr);
      expect(result.title).toBe(TITLE_NO_ACCESS_404);
    });

    test('"Permission denied" + "Authentication failed" stderr → 403 title (403 wins)', () => {
      // Same shape, different pair: 403 fires before auth in the
      // ordering, so the explicit-denial title wins over the generic
      // auth-failed title even when both phrases are present.
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
      // simple-git can hand back multi-page stderr on weird upstream
      // failures. Pinning to `toBe(500)` rather than `<= 500` catches
      // a regression where `MAX_DETAIL_LEN` drifts to a smaller cap.
      // Mirrors the cap applied by the share-publish subprocess close
      // handler (`redactShareSubprocessStderr(...).slice(0, 500)`).
      const stderr = `fatal: ${'x'.repeat(10_000)}`;
      const result = classifyCloneError(stderr);
      expect(result.detail.length).toBe(500);
      // Truncation is from the right end — the start of the message
      // (most useful diagnostic info) is preserved.
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
