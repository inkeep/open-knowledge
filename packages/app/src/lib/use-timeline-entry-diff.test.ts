import { describe, expect, test } from 'vitest';
import { computeTimelineDiff, timelineEntryCacheKey } from './use-timeline-entry-diff';

describe('timelineEntryCacheKey', () => {
  test('composes docName and sha with a NUL separator', () => {
    expect(timelineEntryCacheKey('foo', 'abc123')).toBe('foo\u0000abc123');
    expect(timelineEntryCacheKey('docs/page', 'abc123')).toBe('docs/page\u0000abc123');
  });

  test('different docs with the same sha produce different keys', () => {
    expect(timelineEntryCacheKey('foo', 'abc')).not.toBe(timelineEntryCacheKey('bar', 'abc'));
  });

  test('same doc + sha produces the same key', () => {
    expect(timelineEntryCacheKey('foo', 'abc')).toBe(timelineEntryCacheKey('foo', 'abc'));
  });
});

describe('computeTimelineDiff', () => {
  test('returns empty string when bodies are identical after frontmatter strip', () => {
    const historical = '---\ntitle: a\n---\nhello world';
    const current = '---\ntitle: b\n---\nhello world';
    expect(computeTimelineDiff(historical, current, 'doc')).toBe('');
  });

  test('returns empty string when both inputs are empty', () => {
    expect(computeTimelineDiff('', '', 'doc')).toBe('');
  });

  test('returns non-empty unified diff when bodies differ', () => {
    const historical = 'line1\nline2\nline3\n';
    const current = 'line1\nLINE TWO\nline3\n';
    const out = computeTimelineDiff(historical, current, 'doc');
    expect(out).toContain('@@');
    expect(out).toContain('-line2');
    expect(out).toContain('+LINE TWO');
  });

  test('strips frontmatter from both sides before comparing', () => {
    const historical = '---\ntitle: old\n---\nbody';
    const current = '---\ntitle: new\n---\nbody';
    expect(computeTimelineDiff(historical, current, 'doc')).toBe('');
  });

  test('frontmatter difference alone does not produce a diff', () => {
    const historical = '---\nauthor: a\n---\nsame body';
    const current = '---\nauthor: b\n---\nsame body';
    expect(computeTimelineDiff(historical, current, 'doc')).toBe('');
  });

  test('a body change with frontmatter unchanged still produces a diff', () => {
    const historical = '---\ntitle: t\n---\nold body';
    const current = '---\ntitle: t\n---\nnew body';
    const out = computeTimelineDiff(historical, current, 'doc');
    expect(out).toContain('-old body');
    expect(out).toContain('+new body');
  });

  test('docName is reflected in the patch header', () => {
    const out = computeTimelineDiff('a\n', 'b\n', 'docs/timeline');
    expect(out).toContain('docs/timeline');
  });

  test('handles empty historical against non-empty current (a "new file" case)', () => {
    const out = computeTimelineDiff('', 'fresh content\n', 'doc');
    expect(out).toContain('+fresh content');
  });

  test('handles non-empty historical against empty current (a "deleted file" case)', () => {
    const out = computeTimelineDiff('was here\n', '', 'doc');
    expect(out).toContain('-was here');
  });
});
