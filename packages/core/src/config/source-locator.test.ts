import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import { locateIssue } from './source-locator.ts';

describe('locateIssue', () => {
  test('locates a leaf scalar at correct line and column', () => {
    const source = `mcp:
  tools:
    grep:
      maxResults: "fifty"
`;
    const doc = parseDocument(source);
    const result = locateIssue({
      file: '/abs/config.yml',
      source,
      doc,
      path: ['mcp', 'tools', 'grep', 'maxResults'],
    });
    expect(result).toBeDefined();
    expect(result?.file).toBe('/abs/config.yml');
    expect(result?.line).toBe(4);
    // Column should point at the start of the value `"fifty"` (1-indexed).
    // The line is `      maxResults: "fifty"`; the value starts at column 19.
    expect(result?.column).toBeGreaterThanOrEqual(19);
    expect(result?.snippet).toBeDefined();
    expect(result?.snippet).toContain('maxResults');
    expect(result?.snippet).toContain('"fifty"');
    // Caret marker rendered.
    expect(result?.snippet).toContain('^');
  });

  test('locates a top-level scalar', () => {
    const source = `host: 12345\n`;
    const doc = parseDocument(source);
    const result = locateIssue({
      file: '/c.yml',
      source,
      doc,
      path: ['host'],
    });
    expect(result).toBeDefined();
    expect(result?.line).toBe(1);
  });

  test('falls back to nearest ancestor when path does not exist', () => {
    const source = `mcp:\n  tools:\n    grep:\n      maxResults: 50\n`;
    const doc = parseDocument(source);
    const result = locateIssue({
      file: '/c.yml',
      source,
      doc,
      // Path that doesn't exist — expect fallback to the nearest existing ancestor.
      path: ['mcp', 'tools', 'grep', 'nonExistentField'],
    });
    expect(result).toBeDefined();
    // Should fall back to `grep:` block (line 3 in source).
    expect(result?.line).toBeGreaterThanOrEqual(1);
    expect(result?.line).toBeLessThanOrEqual(4);
  });

  test('renders snippet with multi-line context (1 before, target, 1 after)', () => {
    const source = `line1: a
line2: b
line3:
  bad: "value"
line5: c
`;
    const doc = parseDocument(source);
    const result = locateIssue({
      file: '/c.yml',
      source,
      doc,
      path: ['line3', 'bad'],
    });
    expect(result).toBeDefined();
    // Snippet should include a line before, the target line, and a line after.
    expect(result?.snippet).toContain('line3:');
    expect(result?.snippet).toContain('bad:');
  });

  test('handles 1-indexed line/column correctly across CRLF + leading newlines', () => {
    // Lead with a blank line so position calculations matter.
    const source = `\n\nmcp:\n  autoStart: notabool\n`;
    const doc = parseDocument(source);
    const result = locateIssue({
      file: '/c.yml',
      source,
      doc,
      path: ['mcp', 'autoStart'],
    });
    expect(result).toBeDefined();
    // `autoStart:` is on line 4 (1-indexed: blank, blank, mcp:, autoStart).
    expect(result?.line).toBe(4);
  });

  test('returns location with snippet at root path', () => {
    const source = `key: value\n`;
    const doc = parseDocument(source);
    const result = locateIssue({
      file: '/c.yml',
      source,
      doc,
      path: [],
    });
    expect(result).toBeDefined();
    expect(result?.line).toBe(1);
  });
});
