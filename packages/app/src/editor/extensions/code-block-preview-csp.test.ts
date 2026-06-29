
import { describe, expect, test } from 'bun:test';
import { buildPreviewIframeHeader } from './preview-iframe-header';

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
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test("never grants 'unsafe-eval'", () => {
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('never opens to `*` or a plaintext http:/ws: scheme-source', () => {
    expect(csp).not.toContain('*');
    expect(csp).not.toMatch(/[\s;]http:(?!\/)/);
    expect(csp).not.toMatch(/[\s;]ws:(?!\/)/);
  });
});
