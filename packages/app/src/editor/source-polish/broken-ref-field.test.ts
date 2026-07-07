import { describe, expect, test } from 'bun:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { scanBrokenRefs } from './broken-ref-field';

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

/** Helper: collect decoration ranges from a DecorationSet. */
function collectRanges(state: EditorState): Array<{ from: number; to: number }> {
  const decos = scanBrokenRefs(state);
  const ranges: Array<{ from: number; to: number }> = [];
  const cursor = decos.iter();
  while (cursor.value) {
    ranges.push({ from: cursor.from, to: cursor.to });
    cursor.next();
  }
  return ranges;
}

describe('broken-ref-field', () => {
  test('broken reference gets marked', () => {
    const state = createState('[click here][missing]\n\nSome text.');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(0);
    expect(ranges[0].to).toBe(21); // [click here][missing] = 21 chars
  });

  test('valid reference does not get marked', () => {
    const state = createState('[click here][intro]\n\n[intro]: https://example.com');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('case-insensitive label matching', () => {
    const state = createState('[text][MyLabel]\n\n[mylabel]: https://example.com');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('removing a definition marks all its references', () => {
    // With definition
    const withDef = createState('[a][foo] and [b][foo]\n\n[foo]: https://example.com');
    expect(collectRanges(withDef)).toHaveLength(0);

    // Without definition
    const withoutDef = createState('[a][foo] and [b][foo]');
    const ranges = collectRanges(withoutDef);
    expect(ranges).toHaveLength(2);
  });

  test('adding a definition clears all its broken marks', () => {
    const broken = createState('[text][new]');
    expect(collectRanges(broken)).toHaveLength(1);

    // After adding definition
    const fixed = createState('[text][new]\n\n[new]: https://example.com');
    expect(collectRanges(fixed)).toHaveLength(0);
  });

  test('multiple definitions and references', () => {
    const doc = [
      '[a][one] [b][two] [c][three]',
      '',
      '[one]: https://one.com',
      '[two]: https://two.com',
    ].join('\n');
    const state = createState(doc);
    const ranges = collectRanges(state);
    // Only [c][three] should be broken
    expect(ranges).toHaveLength(1);
    const text = doc.slice(ranges[0].from, ranges[0].to);
    expect(text).toBe('[c][three]');
  });

  test('definition lines are not matched as inline references', () => {
    const state = createState('[label]: https://example.com');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('empty doc produces no decorations', () => {
    const state = createState('');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('doc with no references produces no decorations', () => {
    const state = createState('# Hello\n\nJust a paragraph with [inline](url) links.');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('references inside fenced code blocks are NOT marked', () => {
    // Specs/READMEs that quote broken ref syntax inside fences must not get
    // a wavy underline — the content is literal source, not a live reference.
    const doc = [
      '# Fenced code example',
      '',
      '```markdown',
      '[foo][missing] is a broken ref',
      '',
      '[real]: https://example.com',
      '```',
      '',
      'After the fence: no refs here.',
    ].join('\n');
    const state = createState(doc);
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('references inside inline code (backticks) are NOT marked', () => {
    const state = createState('Use `[label][missing]` syntax for refs.');
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(0);
  });

  test('broken refs OUTSIDE a fence are still marked when fence-internal refs exist', () => {
    const doc = ['```markdown', '[fenced][noexist]', '```', '', '[real-broken][also-missing]'].join(
      '\n',
    );
    const state = createState(doc);
    const ranges = collectRanges(state);
    // Only the outside-the-fence ref should be marked
    expect(ranges).toHaveLength(1);
    const text = doc.slice(ranges[0].from, ranges[0].to);
    expect(text).toBe('[real-broken][also-missing]');
  });

  test('definition INSIDE a fence does NOT resolve a real reference outside', () => {
    // A `[foo]: url` inside a fence is literal source — must not count as a
    // definition for outside references.
    const doc = ['```markdown', '[foo]: https://example.com', '```', '', '[link][foo]'].join('\n');
    const state = createState(doc);
    const ranges = collectRanges(state);
    expect(ranges).toHaveLength(1);
    const text = doc.slice(ranges[0].from, ranges[0].to);
    expect(text).toBe('[link][foo]');
  });
});
