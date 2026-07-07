/**
 * CSP-directive regression guard for the preview iframe header.
 *
 * The preview iframe runs author/agent-supplied HTML/JS at a null origin
 * (`sandbox="allow-scripts"`, no `allow-same-origin`), so a script can never
 * read the KB, cookies, auth, or the parent DOM. The CSP governs only the
 * iframe's network surface, and it is intentionally open — but bounded:
 * scheme-sources only, never `*`, never plaintext `http:`/`ws:`, never
 * `'unsafe-eval'`, with `form-action`/`base-uri` kept locked. Each assertion
 * pins one of those bounds; an edit that drops one widens the surface past what
 * was reviewed.
 */

import { describe, expect, test } from 'bun:test';
import { buildPreviewIframeHeader } from './preview-iframe-header';

/** Pull the raw CSP string out of the `<meta>` tag (no `"` appears inside it). */
function cspOf(header: string): string {
  return header.match(/content="([^"]+)"/)?.[1] ?? '';
}

describe('buildPreviewIframeHeader — CSP directives', () => {
  const header = buildPreviewIframeHeader('light');
  const csp = cspOf(header);

  test('contains a CSP <meta> tag', () => {
    expect(header).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]+">/);
  });

  test('keeps the default-src deny baseline', () => {
    expect(csp).toContain("default-src 'none'");
  });

  test('opens the network surface to https:/wss: scheme-sources', () => {
    expect(csp).toContain("script-src 'unsafe-inline' https:");
    expect(csp).toContain("style-src 'unsafe-inline' https: data:");
    expect(csp).toContain('img-src https: data: blob:');
    expect(csp).toContain('font-src https: data:');
    expect(csp).toContain('connect-src https: wss: data: blob:');
    expect(csp).toContain('media-src https: data: blob:');
    expect(csp).toContain('frame-src https:');
    expect(csp).toContain('child-src https:');
  });

  test('permits inline scripts + styles (the whole point of the preview)', () => {
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  test('keeps form-action + base-uri locked', () => {
    // No embed needs them; both are cheap exfil/redirect protections kept even
    // under the open network policy.
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("never grants 'unsafe-eval'", () => {
    // eval() / new Function() is never permitted — the common embed libraries
    // (Chart.js, Leaflet, Plotly, and similar) don't need it, and it is a real
    // XSS-amplification vector.
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('never opens to `*` or a plaintext http:/ws: scheme-source', () => {
    // `https:`/`wss:` force TLS; `*` or a bare `http:`/`ws:` would allow
    // plaintext and broaden past a scheme to any origin.
    expect(csp).not.toContain('*');
    expect(csp).not.toMatch(/[\s;]http:(?!\/)/);
    expect(csp).not.toMatch(/[\s;]ws:(?!\/)/);
  });
});
