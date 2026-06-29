import { describe, expect, test } from 'bun:test';
import { basenameFromUrl } from './File.tsx';

describe('basenameFromUrl', () => {
  test('absolute URL — strips host + directory + query string', () => {
    expect(basenameFromUrl('https://host.example.com/path/to/report.pdf?v=3')).toBe('report.pdf');
  });

  test('absolute URL with hash fragment — kept inside pathname segment', () => {
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
    expect(basenameFromUrl('data:text/plain;base64,SGVsbG8=')).toBe('');
  });

  test('blob URL — extracts no filename (transient browser object URL)', () => {
    expect(basenameFromUrl('blob:https://host.example.com/abc-def-123')).toBe('');
    expect(basenameFromUrl('blob:null/d3a1c2-9f8e-7b6c-1d4e')).toBe('');
  });
});
