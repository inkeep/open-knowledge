import { describe, expect, test } from 'bun:test';
import { isSafeNavigationUrl } from './safe-navigation-url';

describe('isSafeNavigationUrl', () => {
  test('permits http + https', () => {
    expect(isSafeNavigationUrl('http://example.com/path')).toBe(true);
    expect(isSafeNavigationUrl('https://example.com')).toBe(true);
    expect(isSafeNavigationUrl('https://example.com/a?b=1#c')).toBe(true);
  });

  test('permits mailto + tel (handled by OS, not renderer)', () => {
    expect(isSafeNavigationUrl('mailto:hi@example.com')).toBe(true);
    expect(isSafeNavigationUrl('tel:+15555551234')).toBe(true);
  });

  // These MUST return false.
  test('rejects javascript: URLs (browser RCE vector)', () => {
    expect(isSafeNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeNavigationUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeNavigationUrl('  javascript:alert(1)  ')).toBe(false);
    expect(isSafeNavigationUrl("javascript:fetch('/api/admin/reset',{method:'POST'})")).toBe(false);
  });

  test('rejects data: URLs', () => {
    expect(isSafeNavigationUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  test('rejects vbscript: (IE legacy, still dangerous)', () => {
    expect(isSafeNavigationUrl('vbscript:msgbox(1)')).toBe(false);
  });

  test('rejects file:, ws:, blob:', () => {
    expect(isSafeNavigationUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeNavigationUrl('ws://example.com/socket')).toBe(false);
    expect(isSafeNavigationUrl('blob:https://example.com/abc')).toBe(false);
  });

  test('rejects relative + scheme-less strings (caller must use internal-link helpers)', () => {
    expect(isSafeNavigationUrl('')).toBe(false);
    expect(isSafeNavigationUrl('/path')).toBe(false);
    expect(isSafeNavigationUrl('./doc.md')).toBe(false);
    expect(isSafeNavigationUrl('docName')).toBe(false);
    expect(isSafeNavigationUrl('#anchor')).toBe(false);
  });

  test('rejects non-string garbage shaped inputs via URL parse failure', () => {
    expect(isSafeNavigationUrl('not a valid url at all')).toBe(false);
    expect(isSafeNavigationUrl('http:// with space.com')).toBe(false);
  });
});
