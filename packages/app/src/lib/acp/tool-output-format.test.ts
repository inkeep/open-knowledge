import { describe, expect, test } from 'vitest';
import { jsonMarkdown, looksLikeMarkdown, prettyJson, toolOutputMode } from './tool-output-format';

describe('toolOutputMode', () => {
  test('shell output is never read as markdown, whatever it contains', () => {
    expect(toolOutputMode({ toolKind: 'execute', locations: [], diffs: [] })).toBe('code');
  });

  test('a call that touched a markdown document renders its output as markdown', () => {
    expect(
      toolOutputMode({ toolKind: 'read', locations: [{ path: 'notes/today.md' }], diffs: [] }),
    ).toBe('markdown');
    expect(
      toolOutputMode({ toolKind: 'edit', locations: [], diffs: [{ path: 'docs/intro.mdx' }] }),
    ).toBe('markdown');
  });

  test('a call that touched any other file is code', () => {
    expect(
      toolOutputMode({ toolKind: 'read', locations: [{ path: 'src/index.ts' }], diffs: [] }),
    ).toBe('code');
  });

  test('with nothing to go on, the text itself decides', () => {
    expect(toolOutputMode({ toolKind: 'other', locations: [], diffs: [] })).toBe('auto');
  });
});

describe('looksLikeMarkdown', () => {
  test('balanced fences, a heading, three list items, or a table count', () => {
    expect(looksLikeMarkdown('see:\n```\ncode\n```')).toBe(true);
    expect(looksLikeMarkdown('## Findings\nnothing yet')).toBe(true);
    expect(looksLikeMarkdown('- one\n- two\n- three')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
  });

  test('plain text, two list items, or a lone fence do not', () => {
    expect(looksLikeMarkdown('all 12 tests passed')).toBe(false);
    expect(looksLikeMarkdown('- one\n- two')).toBe(false);
    expect(looksLikeMarkdown('output:\n```\nstill streaming')).toBe(false);
    expect(looksLikeMarkdown('   ')).toBe(false);
  });

  test('a fence outweighs everything else, so an unbalanced one blocks a heading', () => {
    expect(looksLikeMarkdown('# title\n```\nopen')).toBe(false);
  });
});

describe('prettyJson', () => {
  test('an object or array is reindented', () => {
    expect(prettyJson('{"ok":true,"n":[1,2]}')).toBe(
      '{\n  "ok": true,\n  "n": [\n    1,\n    2\n  ]\n}',
    );
    expect(prettyJson(' [1] ')).toBe('[\n  1\n]');
  });

  test('scalars, prose and broken JSON are left alone', () => {
    expect(prettyJson('42')).toBeNull();
    expect(prettyJson('"text"')).toBeNull();
    expect(prettyJson('{not json')).toBeNull();
    expect(prettyJson('done')).toBeNull();
  });

  test('a huge payload is cut with an ellipsis', () => {
    const big = JSON.stringify({ items: Array.from({ length: 5_000 }, (_, i) => `item-${i}`) });
    const pretty = prettyJson(big);
    expect(pretty?.length).toBe(20_001);
    expect(pretty?.endsWith('…')).toBe(true);
  });

  test('a payload too large to parse cheaply is left alone', () => {
    const huge = `{"items":[${'"x",'.repeat(60_000)}"x"]}`;
    expect(huge.length).toBeGreaterThan(200_000);
    expect(prettyJson(huge)).toBeNull();
  });
});

describe('jsonMarkdown', () => {
  test('wraps in a json fence, widened only past a line that would close it', () => {
    expect(jsonMarkdown('{"a":1}')).toBe('```json\n{"a":1}\n```');
    expect(jsonMarkdown('{"a":"```"}')).toBe('```json\n{"a":"```"}\n```');
    expect(jsonMarkdown('```')).toBe('````json\n```\n````');
  });
});
