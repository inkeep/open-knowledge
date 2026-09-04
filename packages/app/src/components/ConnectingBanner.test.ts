import { describe, expect, test } from 'vitest';
import { computeBannerMode, describeError, isNoCollabServerError } from './ConnectingBanner';

describe('computeBannerMode', () => {
  test('hidden during grace window on fresh mount (prevents flash)', () => {
    expect(computeBannerMode(null, false, false)).toBe('hidden');
  });

  test('hidden after resolution regardless of grace state', () => {
    expect(computeBannerMode('ws://localhost:5173/collab', false, false)).toBe('hidden');
    expect(computeBannerMode('ws://localhost:5173/collab', false, true)).toBe('hidden');
  });

  test('retrying once grace elapses and URL still null', () => {
    expect(computeBannerMode(null, false, true)).toBe('retrying');
  });

  test('terminal overrides grace — shown immediately after 30s timeout', () => {
    expect(computeBannerMode(null, true, false)).toBe('terminal');
  });

  test('terminal overrides a resolved URL (defensive — should not occur in practice)', () => {
    expect(computeBannerMode('ws://localhost:5173/collab', true, true)).toBe('terminal');
  });

  test('full state matrix', () => {
    const cases: Array<{ url: string | null; term: boolean; grace: boolean; want: string }> = [
      { url: null, term: false, grace: false, want: 'hidden' },
      { url: null, term: false, grace: true, want: 'retrying' },
      { url: null, term: true, grace: false, want: 'terminal' },
      { url: null, term: true, grace: true, want: 'terminal' },
      { url: 'ws://x/collab', term: false, grace: false, want: 'hidden' },
      { url: 'ws://x/collab', term: false, grace: true, want: 'hidden' },
      { url: 'ws://x/collab', term: true, grace: false, want: 'terminal' },
      { url: 'ws://x/collab', term: true, grace: true, want: 'terminal' },
    ];
    for (const c of cases) {
      expect(computeBannerMode(c.url, c.term, c.grace)).toBe(
        c.want as 'hidden' | 'retrying' | 'terminal',
      );
    }
  });
});

describe('describeError', () => {
  test('null → "no response"', () => {
    expect(describeError(null)).toBe('no response');
  });

  test('null-collab kind names server.lock as the culprit', () => {
    expect(describeError({ kind: 'null-collab' })).toBe(
      'the server responded but server.lock has no port yet',
    );
  });

  test('network error points at missing ok start', () => {
    expect(describeError({ kind: 'error', code: 'network' })).toBe(
      'network error (is `ok start` running?)',
    );
  });

  test('invalid-body error describes the malformed response', () => {
    expect(describeError({ kind: 'error', code: 'invalid-body' })).toBe(
      '/api/config returned a malformed body',
    );
  });

  test('HTTP status code renders the numeric code verbatim', () => {
    expect(describeError({ kind: 'error', code: 404 })).toBe('/api/config returned HTTP 404');
    expect(describeError({ kind: 'error', code: 500 })).toBe('/api/config returned HTTP 500');
  });
});

describe('isNoCollabServerError (D4 — worktree-no-collab-server message branch)', () => {
  test('null-collab → true (UI up, no server.lock — the worktree case)', () => {
    expect(isNoCollabServerError({ kind: 'null-collab' })).toBe(true);
  });

  test('transport/HTTP/network errors → false (keep the generic diagnostic)', () => {
    expect(isNoCollabServerError(null)).toBe(false);
    expect(isNoCollabServerError({ kind: 'error', code: 'network' })).toBe(false);
    expect(isNoCollabServerError({ kind: 'error', code: 'invalid-body' })).toBe(false);
    expect(isNoCollabServerError({ kind: 'error', code: 503 })).toBe(false);
  });
});
