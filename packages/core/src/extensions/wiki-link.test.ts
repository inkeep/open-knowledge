import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { MarkdownManager } from '../markdown/index.ts';
import { sharedExtensions } from './shared';
import {
  getWikiLinkText,
  normalizeNullableString,
  parseWikiLink,
  renderWikiLink,
} from './wiki-link';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

describe('parseWikiLink', () => {
  test('parses bare page target', () => {
    expect(parseWikiLink('[[Page]]')).toEqual({
      type: 'wikilink',
      raw: '[[Page]]',
      target: 'Page',
      alias: null,
      anchor: null,
    });
  });

  test('parses alias and section variants', () => {
    expect(parseWikiLink('[[Page|Alias]]')?.alias).toBe('Alias');
    expect(parseWikiLink('[[Page#Heading]]')?.anchor).toBe('Heading');
    expect(parseWikiLink('[[Page#Heading|Alias]]')).toEqual({
      type: 'wikilink',
      raw: '[[Page#Heading|Alias]]',
      target: 'Page',
      alias: 'Alias',
      anchor: 'Heading',
    });
  });

  test('rejects invalid syntax', () => {
    expect(parseWikiLink('[Page]')).toBeNull();
    expect(parseWikiLink('[[ ]]')).toBeNull();
  });
});

describe('parseWikiLink: escaped alias separator', () => {
  test('escaped separator after an anchor leaves the anchor clean', () => {
    expect(
      parseWikiLink(String.raw`[[targets/existing-page#details\|Wiki alias to details]]`),
    ).toEqual({
      type: 'wikilink',
      raw: String.raw`[[targets/existing-page#details\|Wiki alias to details]]`,
      target: 'targets/existing-page',
      anchor: 'details',
      alias: 'Wiki alias to details',
    });
  });

  test('escaped separator with no anchor leaves the target clean', () => {
    expect(parseWikiLink(String.raw`[[https://inkeep.com\|External wiki link]]`)).toEqual({
      type: 'wikilink',
      raw: String.raw`[[https://inkeep.com\|External wiki link]]`,
      target: 'https://inkeep.com',
      anchor: null,
      alias: 'External wiki link',
    });
  });

  test('escaped pipe folded into the alias unescapes', () => {
    expect(parseWikiLink(String.raw`[[a\|b\|c]]`)).toEqual({
      type: 'wikilink',
      raw: String.raw`[[a\|b\|c]]`,
      target: 'a',
      anchor: null,
      alias: 'b|c',
    });
  });

  test('an escaped separator after an anchor with an empty anchor drops the anchor', () => {
    expect(parseWikiLink(String.raw`[[Page#\|Alias]]`)).toEqual({
      type: 'wikilink',
      raw: String.raw`[[Page#\|Alias]]`,
      target: 'Page',
      anchor: null,
      alias: 'Alias',
    });
  });

  test('a target that is only the separator escape rejects', () => {
    expect(parseWikiLink(String.raw`[[\|alias]]`)).toBeNull();
    expect(parseWikiLink(String.raw`[[ \|alias]]`)).toBeNull();
  });

  test('a backslash not at the separator boundary stays literal', () => {
    expect(parseWikiLink(String.raw`[[a\b|Alias]]`)).toMatchObject({
      target: String.raw`a\b`,
      alias: 'Alias',
    });
  });

  test('a trailing backslash with no alias stays literal', () => {
    expect(parseWikiLink(String.raw`[[a\]]`)).toEqual({
      type: 'wikilink',
      raw: String.raw`[[a\]]`,
      target: 'a\\',
      anchor: null,
      alias: null,
    });
  });

  test('unescaped separators keep parsing as before', () => {
    expect(parseWikiLink('[[targets/existing-page#details|Wiki alias to details]]')).toMatchObject({
      target: 'targets/existing-page',
      anchor: 'details',
      alias: 'Wiki alias to details',
    });
    expect(parseWikiLink('[[https://inkeep.com|External wiki link]]')).toMatchObject({
      target: 'https://inkeep.com',
      anchor: null,
      alias: 'External wiki link',
    });
  });
});

describe('wikiLink helpers', () => {
  test('normalizes nullable strings', () => {
    expect(normalizeNullableString('  Alias  ')).toBe('Alias');
    expect(normalizeNullableString('   ')).toBeNull();
    expect(normalizeNullableString(null)).toBeNull();
  });

  test('renders markdown syntax from attrs', () => {
    expect(renderWikiLink({ target: 'Page', alias: null, anchor: null })).toBe('[[Page]]');
    expect(renderWikiLink({ target: 'Page', alias: 'Alias', anchor: null })).toBe('[[Page|Alias]]');
    expect(renderWikiLink({ target: 'Page', alias: null, anchor: 'Heading' })).toBe(
      '[[Page#Heading]]',
    );
    expect(renderWikiLink({ target: 'Page', alias: 'Alias', anchor: 'Heading' })).toBe(
      '[[Page#Heading|Alias]]',
    );
  });

  test('escapes a pipe inside the alias so the rendered form re-parses losslessly: renderWikiLink is destination-agnostic and escapes every pipe the moment the alias contains one, while destination-aware table-cell emit belongs to the serializer', () => {
    const rendered = renderWikiLink({ target: 'Page', alias: 'a|b', anchor: null });
    expect(rendered).toBe('[[Page\\|a\\|b]]');
    expect(parseWikiLink(rendered)?.target).toBe('Page');
    expect(parseWikiLink(rendered)?.alias).toBe('a|b');
    const row = `| L |\n| --- |\n| ${rendered} |`;
    expect(mdManager.serialize(mdManager.parse(row)).trim()).toBe(row);
  });

  test('an alias whose own value carries a backslash before a pipe escapes the pipe and leaves the backslash literal, so the decoded rule and a parity-aware one are observably different here, and the even backslash run this leaves is not cell-safe: no form is both byte-exact and cell-safe for this value, so a cell must go through the serializer rather than inherit this output', () => {
    const rendered = renderWikiLink({ target: 'Page', alias: String.raw`a\|b`, anchor: null });
    expect(rendered).toBe(String.raw`[[Page\|a\\|b]]`);
    expect(parseWikiLink(rendered)?.alias).toBe(String.raw`a\|b`);

    const row = `| L |\n| --- |\n| ${rendered} |`;
    const inCell = mdManager.serialize(mdManager.parse(row)).trim();
    expect(inCell).not.toBe(row);
    expect(inCell).toBe(`| L |  |\n| --- | - |\n| [[Page\\|a\\\\ | b]] |`);
  });

  test('prefers alias as display text', () => {
    expect(getWikiLinkText({ target: 'Page', alias: 'Alias', anchor: 'Heading' })).toBe('Alias');
    expect(getWikiLinkText({ target: 'Page', alias: null, anchor: 'Heading' })).toBe(
      'Page#Heading',
    );
  });
});

describe('wikiLink round-trip', () => {
  const fixtures = [
    'Alpha [[Page]]\n',
    'Beta [[Page|Alias]]\n',
    'Gamma [[Page#Heading]]\n',
    'Delta [[Page#Heading|Alias]]\n',
  ];

  for (const original of fixtures) {
    test(original.trim(), () => {
      const parsed = mdManager.parse(original);
      const serialized = mdManager.serialize(parsed);

      expect(serialized.trim()).toBe(original.trim());

      const pmNode = schema.nodeFromJSON(parsed);
      const paragraph = pmNode.firstChild;
      let hasWikiLink = false;

      paragraph?.forEach((child) => {
        if (child.type.name === 'wikiLink') {
          hasWikiLink = true;
        }
      });

      expect(hasWikiLink).toBe(true);
    });
  }
});

describe('wikiLink PM round-trip with escaped alias separators', () => {
  const fixtures = [
    String.raw`[[targets/existing-page#details\|Wiki alias to details]]`,
    String.raw`[[https://inkeep.com\|External wiki link]]`,
    String.raw`[[a\|b\|c]]`,
    String.raw`![[Attachments/pic.png\|Alt text]]`,
    String.raw`![[file.pdf#page=3\|Page 3]]`,
    String.raw`[[Page#\|Alias]]`,
    String.raw`![[Page#\|Alt]]`,
    String.raw`[[Page\| ]]`,
    String.raw`[[Page#head\| ]]`,
    String.raw`![[Page\| ]]`,
    '[[Page#Heading|Alias]]',
    '[[ Page # Heading | Alias ]]',
  ];

  for (const original of fixtures) {
    test(original, () => {
      expect(mdManager.serialize(mdManager.parse(`${original}\n`)).trim()).toBe(original);
    });
  }
});

describe('an alias edited to hold a backslash before a pipe keeps the backslash on disk and loses it on the next open', () => {
  const findWikiLinkNode = (node: JSONContent): JSONContent | null => {
    if (node.type === 'wikiLink') return node;
    for (const child of node.content ?? []) {
      const found = findWikiLinkNode(child);
      if (found) return found;
    }
    return null;
  };

  const findEmbedTextNode = (node: JSONContent): JSONContent | null => {
    if (node.marks?.some((mark) => mark.attrs?.sourceForm === 'wikiembed')) return node;
    for (const child of node.content ?? []) {
      const found = findEmbedTextNode(child);
      if (found) return found;
    }
    return null;
  };

  const parseCopy = (source: string): JSONContent =>
    JSON.parse(JSON.stringify(mdManager.parse(source))) as JSONContent;

  const emitEditedWikiLinkAlias = (source: string, alias: string): string => {
    const doc = parseCopy(source);
    const node = findWikiLinkNode(doc);
    if (!node?.attrs) throw new Error('expected a wikiLink node with attrs in the parsed source');
    node.attrs.alias = alias;
    node.attrs.sourceTarget = null;
    node.attrs.sourceAlias = null;
    return mdManager.serialize(doc);
  };

  const emitEditedEmbedAlias = (source: string, alias: string): string => {
    const doc = parseCopy(source);
    const text = findEmbedTextNode(doc);
    const mark = text?.marks?.find((m) => m.attrs?.sourceForm === 'wikiembed');
    if (!text || !mark?.attrs) throw new Error('expected an embed link mark in the parsed source');
    mark.attrs.alias = alias;
    mark.attrs.sourceTarget = null;
    mark.attrs.sourceAlias = null;
    text.text = alias;
    return mdManager.serialize(doc);
  };

  const reparsedWikiLinkAlias = (markdown: string): unknown =>
    findWikiLinkNode(parseCopy(markdown))?.attrs?.alias;

  const reparsedEmbedAlias = (markdown: string): unknown =>
    findEmbedTextNode(parseCopy(markdown))?.marks?.find((m) => m.attrs?.sourceForm === 'wikiembed')
      ?.attrs?.alias;

  test('a wiki link in a table cell keeps the row and writes the backslash, then reads back without it', () => {
    const emitted = emitEditedWikiLinkAlias(
      '| L |\n| --- |\n| [[Page\\|plain]] |\n',
      String.raw`a\|b`,
    );
    expect(emitted).toBe('| L |\n| --- |\n| [[Page\\|a\\|b]] |\n');
    expect(emitted).toContain(String.raw`a\|b`);
    expect(findWikiLinkNode(parseCopy(emitted))?.attrs?.target).toBe('Page');
    expect(reparsedWikiLinkAlias(emitted)).toBe('a|b');
  });

  test('a wiki link outside a cell keeps a bare separator and loses the backslash the same way', () => {
    const emitted = emitEditedWikiLinkAlias('[[Page\\|plain]]\n', String.raw`a\|b`);
    expect(emitted).toBe('[[Page|a\\|b]]\n');
    expect(reparsedWikiLinkAlias(emitted)).toBe('a|b');
  });

  test('an embed in a table cell behaves the same, reached through its link mark rather than a node type', () => {
    const emitted = emitEditedEmbedAlias(
      '| L |\n| --- |\n| ![[pic.png\\|alt]] |\n',
      String.raw`a\|b`,
    );
    expect(emitted).toBe('| L |\n| --- |\n| ![[pic.png\\|a\\|b]] |\n');
    expect(reparsedEmbedAlias(emitted)).toBe('a|b');
  });

  test('an embed outside a cell loses the backslash the same way', () => {
    const emitted = emitEditedEmbedAlias('see ![[pic.png\\|alt]] here\n', String.raw`a\|b`);
    expect(emitted).toBe('see ![[pic.png|a\\|b]] here\n');
    expect(reparsedEmbedAlias(emitted)).toBe('a|b');
  });
});

describe('wiki tables with escaped alias separators round-trip byte-for-byte', () => {
  const fixtures = [
    '| Link |\n| --- |\n| [[target\\|Friendly label]] |',
    '| L |\n| --- |\n| [[Page#sec\\|Alias]] |',
    '| Asset |\n| --- |\n| ![[photo.png\\|caption]] |',
    '| L |\n| --- |\n| [[Page#\\|Alias]] |',
    '| A |\n| --- |\n| ![[Page#\\|Alt]] |',
    '| L |\n| --- |\n| [[Page\\| ]] |',
  ];

  for (const original of fixtures) {
    test(original, () => {
      expect(mdManager.serialize(mdManager.parse(`${original}\n`)).trim()).toBe(original);
    });
  }
});

describe('inline embeds with escaped alias separators round-trip through the link mark', () => {
  const fixtures = [
    'see ![[pic.png\\|alt]] here',
    'see ![[file.pdf#page=3\\|Page 3]] here',
    'see ![[Page#\\|Alt]] here',
    '| see ![[pic.png\\|alt]] here |\n| --- |\n| x |',
  ];

  for (const original of fixtures) {
    test(original, () => {
      expect(mdManager.serialize(mdManager.parse(`${original}\n`)).trim()).toBe(original);
    });
  }

  test('an inline embed parses to the link-mark representation, not a component', () => {
    const pmNode = schema.nodeFromJSON(mdManager.parse('see ![[pic.png\\|alt]] here\n'));
    const linkMarks: Array<Record<string, unknown>> = [];
    pmNode.descendants((child) => {
      for (const mark of child.marks) {
        if (mark.type.name === 'link') linkMarks.push({ ...mark.attrs });
      }
    });
    expect(linkMarks).toHaveLength(1);
    expect(linkMarks[0]).toMatchObject({
      sourceForm: 'wikiembed',
      target: 'pic.png',
      sourceTarget: 'pic.png\\',
      alias: 'alt',
    });
  });
});
