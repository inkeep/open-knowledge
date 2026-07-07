import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { ListItemNode, ListNode } from './list.ts';

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

  // Import the new MarkdownManager
  const { MarkdownManager } = require('../markdown/index.ts');

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

  test('ordered list delimiter preserved', () => {
    const md = '1) first\n';
    const json = mdManager.parse(md);
    const listNode = json.content?.find((n: { type: string }) => n.type === 'list');
    expect(listNode?.attrs.ordered).toBe(true);
    expect(listNode?.attrs.listMarkerDelimiter).toBe(')');
  });
});

// Regression tests for the input rule priority bug.
// Before the fix, typing `- [ ] ` created a bullet list because the bullet
// rule regex /^\s*([-+*])\s$/ matched `- ` first and the task rule never
// had a chance to fire. The fix adds a negative lookahead to the bullet
// regex so it rejects patterns immediately followed by a checkbox.
describe('list input rule priority (regression for QA-013)', () => {
  // Mirror of the regexes in list.ts — kept in sync manually.
  // If these change in list.ts, update here AND verify the fix still holds.
  const BULLET_RULE_RE = /^\s*([-+*])(?!\s*\[[ xX]\])\s$/;
  const ORDERED_RULE_RE = /^\s*(\d+)([.)])\s$/;
  const TASK_RULE_RE = /^\s*[-*+]\s\[([ xX])\]\s$/;

  test('bullet rule does NOT match task list patterns', () => {
    expect(BULLET_RULE_RE.test('- [ ] ')).toBe(false);
    expect(BULLET_RULE_RE.test('- [x] ')).toBe(false);
    expect(BULLET_RULE_RE.test('- [X] ')).toBe(false);
    expect(BULLET_RULE_RE.test('* [ ] ')).toBe(false);
    expect(BULLET_RULE_RE.test('+ [x] ')).toBe(false);
  });

  test('bullet rule matches plain bullet patterns', () => {
    expect(BULLET_RULE_RE.test('- ')).toBe(true);
    expect(BULLET_RULE_RE.test('* ')).toBe(true);
    expect(BULLET_RULE_RE.test('+ ')).toBe(true);
  });

  test('bullet rule matches with leading whitespace (nested)', () => {
    expect(BULLET_RULE_RE.test('  - ')).toBe(true);
    expect(BULLET_RULE_RE.test('    * ')).toBe(true);
    // And rejects task patterns even when nested
    expect(BULLET_RULE_RE.test('  - [ ] ')).toBe(false);
  });

  test('bullet rule captures the marker character', () => {
    expect('- '.match(BULLET_RULE_RE)?.[1]).toBe('-');
    expect('* '.match(BULLET_RULE_RE)?.[1]).toBe('*');
    expect('+ '.match(BULLET_RULE_RE)?.[1]).toBe('+');
  });

  test('task rule matches task list patterns with unchecked state', () => {
    const m = '- [ ] '.match(TASK_RULE_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(' ');
  });

  test('task rule matches task list patterns with checked state', () => {
    const checkedLower = '- [x] '.match(TASK_RULE_RE);
    expect(checkedLower?.[1]).toBe('x');
    const checkedUpper = '- [X] '.match(TASK_RULE_RE);
    expect(checkedUpper?.[1]).toBe('X');
  });

  test('task rule matches with alternative bullet markers', () => {
    expect(TASK_RULE_RE.test('* [ ] ')).toBe(true);
    expect(TASK_RULE_RE.test('+ [x] ')).toBe(true);
  });

  test('ordered rule does not conflict with bullet or task rules', () => {
    // All three rules are mutually exclusive for their shapes
    expect(BULLET_RULE_RE.test('1. ')).toBe(false);
    expect(TASK_RULE_RE.test('1. ')).toBe(false);
    expect(ORDERED_RULE_RE.test('1. ')).toBe(true);
    expect(ORDERED_RULE_RE.test('- ')).toBe(false);
    expect(ORDERED_RULE_RE.test('- [ ] ')).toBe(false);
  });

  test('ordered rule captures number and delimiter', () => {
    const dot = '1. '.match(ORDERED_RULE_RE);
    expect(dot?.[1]).toBe('1');
    expect(dot?.[2]).toBe('.');
    const paren = '42) '.match(ORDERED_RULE_RE);
    expect(paren?.[1]).toBe('42');
    expect(paren?.[2]).toBe(')');
  });
});
