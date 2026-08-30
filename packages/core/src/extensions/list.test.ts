import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { describe, expect, test } from 'vitest';
import { MarkdownManager } from '../markdown/index.ts';
import {
  BULLET_INPUT_RE,
  ListItemNode,
  ListNode,
  ORDERED_INPUT_RE,
  TASK_BARE_INPUT_RE,
  TASK_MARKER_INPUT_RE,
} from './list.ts';

const extensions = [Document, Paragraph, Text, ListNode, ListItemNode];
const schema = getSchema(extensions);

describe('ListNode schema', () => {
  test('list node exists in schema with correct name', () => {
    expect(schema.nodes.list).toBeDefined();
    expect(schema.nodes.list.name).toBe('list');
  });

  test('listItem node exists in schema with correct name', () => {
    expect(schema.nodes.listItem).toBeDefined();
    expect(schema.nodes.listItem.name).toBe('listItem');
  });

  test('list node is in block group', () => {
    expect(schema.nodes.list.spec.group).toContain('block');
  });

  test('list node is in list group', () => {
    expect(schema.nodes.list.spec.group).toContain('list');
  });

  test('list node content is listItem+', () => {
    expect(schema.nodes.list.spec.content).toBe('listItem+');
  });

  test('listItem content is paragraph block*', () => {
    expect(schema.nodes.listItem.spec.content).toBe('paragraph block*');
  });

  test('list has expected default attrs', () => {
    const node = schema.nodes.list.createAndFill();
    expect(node).not.toBeNull();
    expect(node?.attrs.ordered).toBe(false);
    expect(node?.attrs.start).toBe(1);
    expect(node?.attrs.spread).toBe(false);
    expect(node?.attrs.bulletMarker).toBeNull();
    expect(node?.attrs.listMarkerDelimiter).toBeNull();
  });

  test('listItem has expected default attrs', () => {
    const node = schema.nodes.listItem.createAndFill();
    expect(node).not.toBeNull();
    expect(node?.attrs.checked).toBeNull();
    expect(node?.attrs.spread).toBe(false);
  });

  test('list with ordered=true creates valid structure', () => {
    const item = schema.nodes.listItem.createAndFill({}, schema.nodes.paragraph.createAndFill());
    const list = schema.nodes.list.create(
      { ordered: true, start: 3, listMarkerDelimiter: ')' },
      item ? [item] : [],
    );
    expect(list.attrs.ordered).toBe(true);
    expect(list.attrs.start).toBe(3);
    expect(list.attrs.listMarkerDelimiter).toBe(')');
  });

  test('listItem with checked attr for task lists', () => {
    const item = schema.nodes.listItem.createAndFill(
      { checked: false },
      schema.nodes.paragraph.createAndFill(),
    );
    expect(item?.attrs.checked).toBe(false);

    const checkedItem = schema.nodes.listItem.createAndFill(
      { checked: true },
      schema.nodes.paragraph.createAndFill(),
    );
    expect(checkedItem?.attrs.checked).toBe(true);
  });
});

describe('list + listItem DOM rendering', () => {
  test('bullet list renders as <ul>', () => {
    const node = schema.nodes.list.createAndFill({ ordered: false });
    if (!node) throw new Error('createAndFill returned null');
    const spec = schema.nodes.list.spec.toDOM?.(node);
    // toDOM returns [tag, attrs, 0] — tag should be 'ul' for bullet
    expect(spec).toBeDefined();
    expect(Array.isArray(spec)).toBe(true);
    expect((spec as unknown[])[0]).toBe('ul');
  });

  test('ordered list renders as <ol>', () => {
    const node = schema.nodes.list.createAndFill({ ordered: true });
    if (!node) throw new Error('createAndFill returned null');
    const spec = schema.nodes.list.spec.toDOM?.(node);
    expect(spec).toBeDefined();
    expect(Array.isArray(spec)).toBe(true);
    expect((spec as unknown[])[0]).toBe('ol');
  });

  test('ordered list with start renders start attr', () => {
    const node = schema.nodes.list.createAndFill({ ordered: true, start: 5 });
    if (!node) throw new Error('createAndFill returned null');
    const spec = schema.nodes.list.spec.toDOM?.(node);
    expect(spec).toBeDefined();
    // [tag, attrs, 0] — attrs should include start
    const attrs = (spec as unknown[])[1] as Record<string, unknown>;
    expect(attrs.start).toBe(5);
  });

  test('listItem renders as <li>', () => {
    const node = schema.nodes.listItem.createAndFill();
    if (!node) throw new Error('createAndFill returned null');
    const spec = schema.nodes.listItem.spec.toDOM?.(node);
    expect(spec).toBeDefined();
    expect(Array.isArray(spec)).toBe(true);
    expect((spec as unknown[])[0]).toBe('li');
  });
});

describe('list fidelity attrs', () => {
  test('bulletMarker attr stores dash/asterisk/plus', () => {
    for (const marker of ['-', '*', '+']) {
      const node = schema.nodes.list.createAndFill({
        ordered: false,
        bulletMarker: marker,
      });
      expect(node?.attrs.bulletMarker).toBe(marker);
    }
  });

  test('listMarkerDelimiter attr stores dot/paren', () => {
    for (const delim of ['.', ')']) {
      const node = schema.nodes.list.createAndFill({
        ordered: true,
        listMarkerDelimiter: delim,
      });
      expect(node?.attrs.listMarkerDelimiter).toBe(delim);
    }
  });

  test('spread attr for tight/loose lists', () => {
    const tight = schema.nodes.list.createAndFill({ spread: false });
    expect(tight?.attrs.spread).toBe(false);

    const loose = schema.nodes.list.createAndFill({ spread: true });
    expect(loose?.attrs.spread).toBe(true);
  });
});

describe('list pipeline round-trip (via new MarkdownManager)', () => {
  // These tests use the new MarkdownManager with the unified list schema
  // to verify that the handlers + schema work together.
  // The MarkdownManager from packages/core/src/markdown builds against
  // whatever extensions are provided — when list.ts is registered, it
  // uses the unified `list` + `listItem` path.

  const mdManager = new MarkdownManager({ extensions });

  test('bullet list round-trips', () => {
    const md = '- item one\n- item two\n';
    const json = mdManager.parse(md);
    expect(json.content).toBeDefined();
    // Should contain a list node
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode).toBeDefined();
    expect(listNode.attrs.ordered).toBe(false);
  });

  test('ordered list round-trips', () => {
    const md = '1. first\n2. second\n';
    const json = mdManager.parse(md);
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode).toBeDefined();
    expect(listNode.attrs.ordered).toBe(true);
    expect(listNode.attrs.start).toBe(1);
  });

  test('nested list round-trips', () => {
    const md = '- outer\n  - inner\n';
    const json = mdManager.parse(md);
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode).toBeDefined();
    // Inner list should be inside the first listItem
    const firstItem = listNode?.content?.[0];
    expect(firstItem?.type).toBe('listItem');
    // Should have a nested list as second content child
    const hasNestedList = firstItem?.content?.some((n: { type: string }) => n.type === 'list');
    expect(hasNestedList).toBe(true);
  });

  test('bullet marker preserved via fidelity attr', () => {
    const md = '* item\n';
    const json = mdManager.parse(md);
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode?.attrs.bulletMarker).toBe('*');

    const serialized = mdManager.serialize(json);
    expect(serialized).toContain('* item');
  });

  test('plus bullet marker preserved', () => {
    const md = '+ item\n';
    const json = mdManager.parse(md);
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode?.attrs.bulletMarker).toBe('+');
  });

  // What the task-item input rules construct, on the way back out. The rules
  // accept spellings GFM does not (`[]` with nothing between the brackets), so
  // the write-back is where that widening has to disappear: every unchecked
  // spelling has to land as the canonical `- [ ] `, and only the uppercase box
  // survives as itself.
  test.each([
    { attrs: { checked: false, sourceCheckboxChar: null }, marker: '- [ ]' },
    { attrs: { checked: true, sourceCheckboxChar: null }, marker: '- [x]' },
    { attrs: { checked: true, sourceCheckboxChar: 'X' }, marker: '- [X]' },
  ])('a task item with $attrs serializes as $marker', ({ attrs, marker }) => {
    const md = mdManager.serialize({
      type: 'doc',
      content: [
        {
          type: 'list',
          attrs: { ordered: false, bulletMarker: '-' },
          content: [
            {
              type: 'listItem',
              attrs,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'do it' }] }],
            },
          ],
        },
      ],
    });
    expect(md).toBe(`${marker} do it\n`);
  });

  test('ordered list delimiter preserved', () => {
    const md = '1) first\n';
    const json = mdManager.parse(md);
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode?.attrs.ordered).toBe(true);
    expect(listNode?.attrs.listMarkerDelimiter).toBe(')');
  });
});

// The bullet rule must not claim a checkbox spelling. What enforces that is the
// trailing `\s$`: the rule matches only while the marker is followed by one
// space and nothing else, so `- [` has stopped matching before the bracket is
// closed. A negative lookahead used to sit in this regex claiming the job and
// was removed — it could never fire, and an exhaustive comparison over every
// string of length <= 5 from `-+* \t[]xXa` found no input where it changed the
// verdict. These assertions are pointed at the anchor so they can fail if it
// ever loosens.
describe('bullet rule vs the checkbox spellings', () => {
  test('bullet rule does NOT match task list patterns', () => {
    expect(BULLET_INPUT_RE.test('- [ ] ')).toBe(false);
    expect(BULLET_INPUT_RE.test('- [x] ')).toBe(false);
    expect(BULLET_INPUT_RE.test('- [X] ')).toBe(false);
    expect(BULLET_INPUT_RE.test('* [ ] ')).toBe(false);
    expect(BULLET_INPUT_RE.test('+ [x] ')).toBe(false);
  });

  test('the trailing anchor is what rejects them', () => {
    // Nothing may follow the single space. That is the whole mechanism, so
    // these are the cases that would break first if the anchor loosened.
    expect(BULLET_INPUT_RE.test('- ')).toBe(true);
    expect(BULLET_INPUT_RE.test('- [')).toBe(false);
    expect(BULLET_INPUT_RE.test('-  ')).toBe(false);
    expect(BULLET_INPUT_RE.test('- a')).toBe(false);
  });

  test('bullet rule matches plain bullet patterns', () => {
    expect(BULLET_INPUT_RE.test('- ')).toBe(true);
    expect(BULLET_INPUT_RE.test('* ')).toBe(true);
    expect(BULLET_INPUT_RE.test('+ ')).toBe(true);
  });

  test('bullet rule matches with leading whitespace (nested)', () => {
    expect(BULLET_INPUT_RE.test('  - ')).toBe(true);
    expect(BULLET_INPUT_RE.test('    * ')).toBe(true);
    // And rejects task patterns even when nested
    expect(BULLET_INPUT_RE.test('  - [ ] ')).toBe(false);
  });

  test('bullet rule captures the marker character', () => {
    expect('- '.match(BULLET_INPUT_RE)?.[1]).toBe('-');
    expect('* '.match(BULLET_INPUT_RE)?.[1]).toBe('*');
    expect('+ '.match(BULLET_INPUT_RE)?.[1]).toBe('+');
  });

  test('task rule matches task list patterns with unchecked state', () => {
    const m = '- [ ] '.match(TASK_MARKER_INPUT_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(' ');
  });

  test('task rule matches task list patterns with checked state', () => {
    const checkedLower = '- [x] '.match(TASK_MARKER_INPUT_RE);
    expect(checkedLower?.[1]).toBe('x');
    const checkedUpper = '- [X] '.match(TASK_MARKER_INPUT_RE);
    expect(checkedUpper?.[1]).toBe('X');
  });

  test('task rule matches with alternative bullet markers', () => {
    expect(TASK_MARKER_INPUT_RE.test('* [ ] ')).toBe(true);
    expect(TASK_MARKER_INPUT_RE.test('+ [x] ')).toBe(true);
  });

  test('ordered rule does not conflict with bullet or task rules', () => {
    // All three rules are mutually exclusive for their shapes
    expect(BULLET_INPUT_RE.test('1. ')).toBe(false);
    expect(TASK_MARKER_INPUT_RE.test('1. ')).toBe(false);
    expect(ORDERED_INPUT_RE.test('1. ')).toBe(true);
    expect(ORDERED_INPUT_RE.test('- ')).toBe(false);
    expect(ORDERED_INPUT_RE.test('- [ ] ')).toBe(false);
  });

  test('ordered rule captures number and delimiter', () => {
    const dot = '1. '.match(ORDERED_INPUT_RE);
    expect(dot?.[1]).toBe('1');
    expect(dot?.[2]).toBe('.');
    const paren = '42) '.match(ORDERED_INPUT_RE);
    expect(paren?.[1]).toBe('42');
    expect(paren?.[2]).toBe(')');
  });

  test('bullet rule does NOT match empty-bracket task patterns', () => {
    expect(BULLET_INPUT_RE.test('- [] ')).toBe(false);
    expect(BULLET_INPUT_RE.test('* [] ')).toBe(false);
  });

  test('task rule matches the empty-bracket shorthand', () => {
    const m = '- [] '.match(TASK_MARKER_INPUT_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('');
  });
});

// The bare checkbox shorthand: `[] `, `[ ] `, `[x] `, `[X] ` with no list
// marker. This is the spelling a typing user actually produces — the bullet
// rule claims `- ` at the space, so by the time the `[` is typed the marker is
// already a listItem and TASK_MARKER_INPUT_RE has no prefix left to match. Before this
// rule existed there was NO keystroke sequence that produced a checkbox.
describe('bare task list input rule', () => {
  test('matches every accepted checkbox spelling', () => {
    expect('[] '.match(TASK_BARE_INPUT_RE)?.[1]).toBe('');
    expect('[ ] '.match(TASK_BARE_INPUT_RE)?.[1]).toBe(' ');
    expect('[x] '.match(TASK_BARE_INPUT_RE)?.[1]).toBe('x');
    expect('[X] '.match(TASK_BARE_INPUT_RE)?.[1]).toBe('X');
  });

  test('matches with leading whitespace (nested)', () => {
    expect(TASK_BARE_INPUT_RE.test('  [] ')).toBe(true);
    expect(TASK_BARE_INPUT_RE.test('    [x] ')).toBe(true);
  });

  test('does not match a wikilink opener or a bracketed word', () => {
    expect(TASK_BARE_INPUT_RE.test('[[')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('[[] ')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('[a] ')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('[xy] ')).toBe(false);
  });

  test('does not match a hyphenated marker (TASK_MARKER_INPUT_RE owns that shape)', () => {
    expect(TASK_BARE_INPUT_RE.test('- [] ')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('* [x] ')).toBe(false);
  });

  // Pinned against TipTap's own TaskItem `inputRegex`, which this rule is
  // adapted from. Both departures are deliberate; if someone later "aligns
  // with upstream" they should have to delete an assertion that says why.
  test('departs from upstream TipTap only where intended', () => {
    const TIPTAP_TASK_ITEM_RE = /^\s*(\[([( |x])?\])\s$/;

    // Agreement on every spelling that matters.
    for (const shared of ['[] ', '[ ] ', '[x] ']) {
      expect(TASK_BARE_INPUT_RE.test(shared)).toBe(true);
      expect(TIPTAP_TASK_ITEM_RE.test(shared)).toBe(true);
    }

    // Departure 1: upstream's `[( |x]` class admits `(` and `|` literally.
    expect(TIPTAP_TASK_ITEM_RE.test('[(] ')).toBe(true);
    expect(TIPTAP_TASK_ITEM_RE.test('[|] ')).toBe(true);
    expect(TASK_BARE_INPUT_RE.test('[(] ')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('[|] ')).toBe(false);

    // Departure 2: upstream cannot produce the uppercase box that
    // `sourceCheckboxChar` round-trips.
    expect(TIPTAP_TASK_ITEM_RE.test('[X] ')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('[X] ')).toBe(true);
  });

  test('is anchored to the start of the textblock', () => {
    expect(TASK_BARE_INPUT_RE.test('a[] ')).toBe(false);
    expect(TASK_BARE_INPUT_RE.test('see [x] ')).toBe(false);
  });
});
