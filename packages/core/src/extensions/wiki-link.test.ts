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
