/**
 * Regression tests for LinkFidelity's URL-scheme allowlist gate
 * (`isAllowedUri` / `validate`).
 *
 * Defense-in-depth at the TipTap input boundary (autolinker, linkOnPaste,
 * setLink command). Storage-layer mdast→PM dispatch in `MarkdownManager`
 * does NOT route through this hook — see AGENTS.md "Storage never
 * sanitizes; render-time layers do" for the load-bearing rationale.
 *
 * Pinning the gate here so a future Tiptap upgrade or refactor that
 * loosens the allowlist (e.g., reverts to a denylist or drops the gate)
 * trips an explicit failure rather than silently widening the input
 * surface for `file:` / `blob:` / `intent:` / future schemes.
 */

import { describe, expect, test } from 'bun:test';
import { LinkFidelity } from './link-fidelity.ts';

const opts = LinkFidelity.config.addOptions?.call({ parent: undefined } as never) as {
  isAllowedUri: (url: string) => boolean;
  validate: (url: string) => boolean;
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

describe('LinkFidelity.validate — same gate as isAllowedUri', () => {
  test('shares the allowlist with isAllowedUri', () => {
    expect(opts.validate('https://example.com')).toBe(true);
    expect(opts.validate('javascript:alert(1)')).toBe(false);
    expect(opts.validate('file:///etc/passwd')).toBe(false);
    expect(opts.validate('/relative')).toBe(true);
  });
});
