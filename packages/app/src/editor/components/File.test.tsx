/**
 * File renderer — pure-helper tests for the basename derivation.
 *
 * The interactive concerns (PM dispatch, hover state, click-to-download)
 * are exercised at a higher tier (Playwright E2E + the JsxComponentView
 * test). The unit-level tests here pin the contract that drives the
 * `displayName` fallback when an author writes `<File src="..." />`
 * without an explicit `name` prop:
 *
 *   - Strip the query string
 *   - Strip directory prefix (relative or absolute URL)
 *   - Percent-decode the final segment
 *   - Empty / undefined input → `''` (renderer falls back to "Untitled file")
 */

import { describe, expect, test } from 'bun:test';
import { basenameFromUrl } from './File.tsx';

describe('basenameFromUrl', () => {
  test('absolute URL — strips host + directory + query string', () => {
    expect(basenameFromUrl('https://host.example.com/path/to/report.pdf?v=3')).toBe('report.pdf');
  });

  test('absolute URL with hash fragment — kept inside pathname segment', () => {
    // `URL.pathname` excludes the fragment, so `#section` drops out.
    expect(basenameFromUrl('https://host.example.com/docs/guide.html#install')).toBe('guide.html');
  });

  test('relative path — strips directory prefix', () => {
    expect(basenameFromUrl('./folder/sub/report-2025.zip')).toBe('report-2025.zip');
    expect(basenameFromUrl('../up/notes.md')).toBe('notes.md');
  });

  test('plain filename — returns as-is', () => {
    expect(basenameFromUrl('report.docx')).toBe('report.docx');
  });

  test('percent-encoded segment — decoded to display form', () => {
    expect(basenameFromUrl('https://host/files/quarterly%20report.pdf')).toBe(
      'quarterly report.pdf',
    );
  });

  test('malformed percent-encoding — returns raw segment without throwing', () => {
    // `decodeURIComponent('%E0%A4%A')` throws URIError; the helper catches.
    expect(basenameFromUrl('https://host/files/bad%E0%A4%A.bin')).toBe('bad%E0%A4%A.bin');
  });

  test('trailing slash — no filename segment', () => {
    expect(basenameFromUrl('https://host/path/to/')).toBe('');
  });

  test('empty / undefined — returns empty string (renderer applies fallback label)', () => {
    expect(basenameFromUrl('')).toBe('');
    expect(basenameFromUrl(undefined)).toBe('');
  });

  test('data URL — extracts no filename (no path component)', () => {
    // `data:` URLs have no usable basename. Returns empty so the renderer's
    // explicit-`name` prop is the only way to label them.
    expect(basenameFromUrl('data:text/plain;base64,SGVsbG8=')).toBe('');
  });

  test('blob URL — extracts no filename (transient browser object URL)', () => {
    // `blob:` URLs are produced by `URL.createObjectURL()` during
    // drag-and-drop file uploads — the URL's path segment is an opaque
    // GUID, not a filename. Returns empty so the renderer's `name`
    // prop (or "Untitled file" fallback) labels the row instead of
    // displaying the GUID.
    expect(basenameFromUrl('blob:https://host.example.com/abc-def-123')).toBe('');
    expect(basenameFromUrl('blob:null/d3a1c2-9f8e-7b6c-1d4e')).toBe('');
  });
});
