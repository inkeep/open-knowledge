import Link from '@tiptap/extension-link';
import { describe, expect, test } from 'vitest';
import { LinkFidelity } from './link-fidelity.ts';

const opts = LinkFidelity.config.addOptions?.call({
  parent: () => Link.config.addOptions?.call({ parent: undefined } as never),
} as never) as {
  isAllowedUri: (url: string) => boolean;
  shouldAutoLink: (url: string) => boolean;
  validate?: (url: string) => boolean;
};

describe('LinkFidelity.isAllowedUri — allowlist posture', () => {
  test('accepts every scheme in SAFE_URL_SCHEMES', () => {
    expect(opts.isAllowedUri('https://example.com')).toBe(true);
    expect(opts.isAllowedUri('http://example.com')).toBe(true);
    expect(opts.isAllowedUri('mailto:user@example.com')).toBe(true);
    expect(opts.isAllowedUri('tel:+15551234567')).toBe(true);
    expect(opts.isAllowedUri('ftp://files.example.com')).toBe(true);
    expect(opts.isAllowedUri('sms:+15551234567?body=hi')).toBe(true);
  });

  test('accepts relative URLs (resolve to https: against placeholder base)', () => {
    expect(opts.isAllowedUri('/abs/path')).toBe(true);
    expect(opts.isAllowedUri('./sibling')).toBe(true);
    expect(opts.isAllowedUri('../parent')).toBe(true);
    expect(opts.isAllowedUri('#fragment')).toBe(true);
    expect(opts.isAllowedUri('?q=1')).toBe(true);
    expect(opts.isAllowedUri('plain/path')).toBe(true);
  });

  test('rejects script-execution schemes', () => {
    expect(opts.isAllowedUri('javascript:alert(1)')).toBe(false);
    expect(opts.isAllowedUri('JAVASCRIPT:alert(1)')).toBe(false);
    expect(opts.isAllowedUri('JaVaScRiPt:alert(1)')).toBe(false);
    expect(opts.isAllowedUri('vbscript:msgbox(1)')).toBe(false);
  });

  test('rejects data: URIs (HTML / image / arbitrary)', () => {
    expect(opts.isAllowedUri('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(opts.isAllowedUri('data:image/png;base64,iVBOR')).toBe(false);
  });

  test('rejects local-resource schemes', () => {
    expect(opts.isAllowedUri('file:///etc/passwd')).toBe(false);
    expect(opts.isAllowedUri('blob:https://example.com/abc')).toBe(false);
  });

  test('fail-closed on novel/unknown schemes', () => {
    expect(opts.isAllowedUri('intent://foo')).toBe(false);
    expect(opts.isAllowedUri('view-source:https://example.com')).toBe(false);
    expect(opts.isAllowedUri('chrome-extension://abc')).toBe(false);
    expect(opts.isAllowedUri('moz-extension://abc')).toBe(false);
    expect(opts.isAllowedUri('ws://example.com')).toBe(false);
    expect(opts.isAllowedUri('wss://example.com')).toBe(false);
  });
});

describe('LinkFidelity autolink gating — isAllowedUri is the sole allowlist', () => {
  test('shouldAutoLink admits everything, leaving isAllowedUri as the only gate', () => {
    expect(opts.isAllowedUri('https://example.com')).toBe(true);
    expect(opts.isAllowedUri('javascript:alert(1)')).toBe(false);
    expect(opts.isAllowedUri('file:///etc/passwd')).toBe(false);
    expect(opts.isAllowedUri('/relative')).toBe(true);
    expect(opts.shouldAutoLink('https://example.com')).toBe(true);
    expect(opts.shouldAutoLink('javascript:alert(1)')).toBe(true);
  });

  test('the deprecated validate option is inherited, never redeclared as a second gate', () => {
    const own = LinkFidelity.config.addOptions?.call({ parent: () => ({}) } as never) as Record<
      string,
      unknown
    >;
    expect('validate' in own).toBe(false);
    expect('isAllowedUri' in own).toBe(true);
    expect('shouldAutoLink' in own).toBe(true);
  });
});

describe('LinkFidelity refuses to build against no parent', () => {
  test('addOptions throws rather than returning an option set with no Link defaults', () => {
    expect(() => LinkFidelity.config.addOptions?.call({ parent: undefined } as never)).toThrow(
      /must be derived from the Link extension/,
    );
  });

  test('addAttributes throws rather than spreading undefined over the attribute map', () => {
    expect(() => LinkFidelity.config.addAttributes?.call({ parent: undefined } as never)).toThrow(
      /must be derived from the Link extension/,
    );
  });

  test('addAttributes keeps the inherited attributes when a parent is present', () => {
    const attrs = LinkFidelity.config.addAttributes?.call({
      parent: () => ({ href: { default: null } }),
    } as never) as Record<string, unknown>;

    expect('href' in attrs).toBe(true);
    expect('linkStyle' in attrs).toBe(true);
  });
});
