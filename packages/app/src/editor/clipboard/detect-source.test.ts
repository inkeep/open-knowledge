/**
 * Tests for the clipboard source-detection dispatcher signal.
 *
 * We build minimal DataTransfer-shaped fakes since jsdom's DataTransfer
 * has limitations; the detection function only reads `.types` and
 * `.getData(key)`, so a plain object suffices.
 */

import { describe, expect, test } from 'bun:test';
import { detectSource } from './detect-source.ts';

function fakeDT(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (key: string) => data[key] ?? '',
  } as unknown as DataTransfer;
}

describe('detectSource', () => {
  test('vscode-editor-data wins over all other MIMEs', () => {
    const dt = fakeDT({
      'vscode-editor-data': '{"mode":"ts"}',
      'text/plain': 'code',
      'text/html': '<p>code</p>',
    });
    expect(detectSource(dt)).toBe('vscode');
  });

  test('text/x-gfm comes next', () => {
    const dt = fakeDT({
      'text/x-gfm': '# md',
      'text/html': '<h1>md</h1>',
    });
    expect(detectSource(dt)).toBe('gfm');
  });

  test('data-pm-slice fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<div data-pm-slice="0 0 doc">hi</div>',
    });
    expect(detectSource(dt)).toBe('pm-origin');
  });

  test('gdocs fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<b id="docs-internal-guid-abc">...</b>',
    });
    expect(detectSource(dt)).toBe('gdocs');
  });

  test('word fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<html xmlns:o="urn:schemas-microsoft-com:office:office">...</html>',
    });
    expect(detectSource(dt)).toBe('word');
  });

  test('gmail fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<div class="gmail_default">...</div>',
    });
    expect(detectSource(dt)).toBe('gmail');
  });

  test('notion fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<!-- notionvc: abc --><p>hi</p>',
    });
    expect(detectSource(dt)).toBe('notion');
  });

  test('apple cocoa fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<meta name="Generator" content="Cocoa HTML Writer"><p>hi</p>',
    });
    expect(detectSource(dt)).toBe('apple');
  });

  test('slack fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<div class="c-message_kit__gutter">...</div>',
    });
    expect(detectSource(dt)).toBe('slack');
  });

  test('gsheets fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<google-sheets-html-origin><table>...</table></google-sheets-html-origin>',
    });
    expect(detectSource(dt)).toBe('gsheets');
  });

  test('github fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<a data-hovercard-type="commit" href="/x">abc</a>',
    });
    expect(detectSource(dt)).toBe('github');
  });

  test('generic HTML with no fingerprint', () => {
    const dt = fakeDT({
      'text/html': '<p>anything</p>',
    });
    expect(detectSource(dt)).toBe('generic');
  });

  test('text/plain only → plaintext', () => {
    const dt = fakeDT({ 'text/plain': 'just text' });
    expect(detectSource(dt)).toBe('plaintext');
  });

  test('null DataTransfer → plaintext', () => {
    expect(detectSource(null)).toBe('plaintext');
  });
});
