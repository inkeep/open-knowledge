import { describe, expect, mock, test } from 'bun:test';
// Test-only cross-package import. Main-process runtime bundle does NOT include
// app-layer code (tree-shaken since no production handler imports from app).
// Relative path over workspace ref
// (prefer direct relative imports over `@inkeep/open-knowledge-core` for tests).
import { KNOWN_TARGETS } from '../../../app/src/lib/handoff/targets.ts';
import {
  ALLOWED_SCHEMES,
  checkOutboundUrl,
  handleShellOpenExternal,
} from '../../src/main/shell-allowlist.ts';

describe('checkOutboundUrl (D47 outbound scheme allowlist)', () => {
  test('allows https:', () => {
    expect(checkOutboundUrl('https://example.com')).toEqual({ ok: true });
  });

  test('allows http:', () => {
    expect(checkOutboundUrl('http://example.com')).toEqual({ ok: true });
  });

  test('allows mailto:', () => {
    expect(checkOutboundUrl('mailto:hello@example.com')).toEqual({ ok: true });
  });

  test('allows openknowledge: (our own deep-link scheme)', () => {
    expect(checkOutboundUrl('openknowledge://open?project=/tmp')).toEqual({ ok: true });
  });

  test('rejects ms-msdt: (Shabarkin 2022 RCE class)', () => {
    const result = checkOutboundUrl('ms-msdt:launch?id=xyz');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('scheme-not-allowed');
  });

  test('rejects file:', () => {
    const result = checkOutboundUrl('file:///etc/passwd');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('scheme-not-allowed');
  });

  test('rejects javascript:', () => {
    const result = checkOutboundUrl('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('scheme-not-allowed');
  });

  test('rejects search-ms:', () => {
    const result = checkOutboundUrl('search-ms:query=x');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('scheme-not-allowed');
  });

  test('rejects malformed URL', () => {
    const result = checkOutboundUrl('not a url');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-url');
  });

  test('rejects data: (data URI RCE class)', () => {
    const result = checkOutboundUrl('data:text/html,<script>alert(1)</script>');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('scheme-not-allowed');
  });

  describe('M4 US-008 AC — per-scheme verification', () => {
    test.each([
      ['https://example.com', true],
      ['http://example.com', true],
      ['mailto:hi@example.com', true],
      ['openknowledge://open?project=/tmp&doc=x', true],
      ['file:///etc/passwd', false],
      ['javascript:alert(1)', false],
      ['data:text/html,x', false],
    ] as const)('checkOutboundUrl(%s) allowed=%s', (url, allowed) => {
      const result = checkOutboundUrl(url);
      expect(result.ok).toBe(allowed);
    });
  });
});

describe('handleShellOpenExternal (preload → main bridge enforcement)', () => {
  test('delegates to openExternal for allowed schemes', async () => {
    const openExternal = mock(() => Promise.resolve());
    const handle = handleShellOpenExternal({ openExternal });
    await handle('https://example.com');
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  test('delegates to openExternal for openknowledge:// (our own scheme)', async () => {
    const openExternal = mock(() => Promise.resolve());
    const handle = handleShellOpenExternal({ openExternal });
    await handle('openknowledge://open?project=/tmp&doc=x');
    expect(openExternal).toHaveBeenCalledWith('openknowledge://open?project=/tmp&doc=x');
  });

  test('rejects file:// with a scheme-not-allowed error (no openExternal call)', async () => {
    const openExternal = mock(() => Promise.resolve());
    const handle = handleShellOpenExternal({ openExternal });
    await expect(handle('file:///etc/passwd')).rejects.toThrow(/scheme-not-allowed/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('rejects javascript: with a scheme-not-allowed error', async () => {
    const openExternal = mock(() => Promise.resolve());
    const handle = handleShellOpenExternal({ openExternal });
    await expect(handle('javascript:alert(1)')).rejects.toThrow(/scheme-not-allowed/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('rejects data: with a scheme-not-allowed error', async () => {
    const openExternal = mock(() => Promise.resolve());
    const handle = handleShellOpenExternal({ openExternal });
    await expect(handle('data:text/html,x')).rejects.toThrow(/scheme-not-allowed/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('rejects malformed URL with invalid-url reason', async () => {
    const openExternal = mock(() => Promise.resolve());
    const handle = handleShellOpenExternal({ openExternal });
    await expect(handle('not a url')).rejects.toThrow(/invalid-url/);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('ALLOWED_SCHEMES exact-set contract (D47 + handoff extension)', () => {
  test('exact-set allowlist membership', () => {
    // Reviewer can grep for
    // this list to find every scheme shell.openExternal will dispatch. Any
    // addition requires a spec-level decision + per-scheme JSDoc rationale.
    expect([...ALLOWED_SCHEMES].sort()).toEqual([
      'claude:',
      'codex:',
      'cursor:',
      'http:',
      'https:',
      'mailto:',
      'openknowledge:',
    ]);
  });
});

describe('checkOutboundUrl — handoff scheme coverage (specs/2026-04-21-open-in-agent-desktop §6.6)', () => {
  test.each([
    ['claude://cowork/new?q=x&folder=y&file=z', true],
    ['claude://code/new?q=x&folder=y&file=z', true],
    ['codex://new?prompt=x&path=y', true],
    ['cursor://anysphere.cursor-deeplink/prompt?text=x&workspace=y&mode=agent', true],
    ['file:///etc/passwd', false],
    ['ms-msdt:/id/PCWDiagnostic', false],
    ['javascript:alert(1)', false],
  ] as const)('checkOutboundUrl(%s).ok === %s', (url, expected) => {
    expect(checkOutboundUrl(url).ok).toBe(expected);
  });
});

describe('drift detector — KNOWN_TARGETS schemes ⊆ ALLOWED_SCHEMES', () => {
  // Intent: if a future spec adds a target to KNOWN_TARGETS without also
  // adding its scheme to ALLOWED_SCHEMES, this test fails at PR tier and
  // blocks the merge. Operates on the pure-data `KNOWN_TARGETS` constant
  // (no registry type; hand-rolled switch).
  test('every KNOWN_TARGETS scheme is in ALLOWED_SCHEMES', () => {
    const knownSchemes = new Set(KNOWN_TARGETS.flatMap((t) => t.schemes));
    expect(knownSchemes.size).toBeGreaterThan(0);
    for (const scheme of knownSchemes) {
      expect(ALLOWED_SCHEMES.has(scheme)).toBe(true);
    }
  });
});
