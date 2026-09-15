import {
  type CleanWikiSegments,
  MarkdownManager,
  parseWikiLink,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { readWikiLinkAt } from './link-syntax.ts';
import {
  findWikiEmbedMarkAttrs,
  findWikiLinkAttrs,
  type PmJson,
} from './wiki-pm-json.test-helper.ts';

let manager: MarkdownManager | null = null;
function markdownManager(): MarkdownManager {
  manager ??= new MarkdownManager({ extensions: sharedExtensions });
  return manager;
}

function segmentsFrom(attrs: Record<string, unknown> | null): CleanWikiSegments | null {
  if (!attrs) return null;
  return {
    target: String(attrs.target ?? ''),
    anchor: (attrs.anchor as string | null) ?? null,
    alias: (attrs.alias as string | null) ?? null,
  };
}

function viaServerScanner(source: string): CleanWikiSegments | null {
  const match = readWikiLinkAt(source, 0);
  return match ? { target: match.target, anchor: match.anchor, alias: match.alias } : null;
}

function viaCoreRegex(source: string): CleanWikiSegments | null {
  const parsed = parseWikiLink(source);
  return parsed ? { target: parsed.target, anchor: parsed.anchor, alias: parsed.alias } : null;
}

function viaMicromark(source: string): CleanWikiSegments | null {
  return segmentsFrom(findWikiLinkAttrs(markdownManager().parse(source) as PmJson));
}

function viaServerScannerEmbed(source: string): CleanWikiSegments | null {
  const match = readWikiLinkAt(source, 0);
  return match?.embed ? { target: match.target, anchor: match.anchor, alias: match.alias } : null;
}

function viaCoreRegexEmbed(source: string): CleanWikiSegments | null {
  return viaCoreRegex(source.slice(1));
}

function viaMicromarkEmbed(source: string): CleanWikiSegments | null {
  return segmentsFrom(findWikiEmbedMarkAttrs(markdownManager().parse(source) as PmJson));
}

const FIXTURES: Array<{
  name: string;
  source: string;
  form?: 'embed';
  expected: CleanWikiSegments | null;
}> = [
  {
    name: 'bare target',
    source: '[[Page]]',
    expected: { target: 'Page', anchor: null, alias: null },
  },
  {
    name: 'anchor only',
    source: '[[Page#Heading]]',
    expected: { target: 'Page', anchor: 'Heading', alias: null },
  },
  {
    name: 'alias only',
    source: '[[Page|Alias]]',
    expected: { target: 'Page', anchor: null, alias: 'Alias' },
  },
  {
    name: 'anchor and alias',
    source: '[[Page#Heading|Alias]]',
    expected: { target: 'Page', anchor: 'Heading', alias: 'Alias' },
  },
  {
    name: 'escaped separator after an anchor',
    source: String.raw`[[targets/existing-page#details\|Wiki alias to details]]`,
    expected: {
      target: 'targets/existing-page',
      anchor: 'details',
      alias: 'Wiki alias to details',
    },
  },
  {
    name: 'escaped separator with no anchor',
    source: String.raw`[[https://inkeep.com\|External wiki link]]`,
    expected: { target: 'https://inkeep.com', anchor: null, alias: 'External wiki link' },
  },
  {
    name: 'escaped separators folded into the alias',
    source: String.raw`[[a\|b\|c]]`,
    expected: { target: 'a', anchor: null, alias: 'b|c' },
  },
  {
    name: 'escaped separator after an anchor with an empty anchor',
    source: String.raw`[[Page#\|Alias]]`,
    expected: { target: 'Page', anchor: null, alias: 'Alias' },
  },
  {
    name: 'a target that is only the separator escape',
    source: String.raw`[[\|alias]]`,
    expected: null,
  },
  {
    name: 'a whitespace-prefixed target that is only the separator escape',
    source: String.raw`[[ \|alias]]`,
    expected: null,
  },
  {
    name: 'unescaped later pipes fold into the alias',
    source: '[[a|b|c]]',
    expected: { target: 'a', anchor: null, alias: 'b|c' },
  },
  {
    name: 'a backslash not at the separator boundary stays literal',
    source: String.raw`[[a\b|Alias]]`,
    expected: { target: String.raw`a\b`, anchor: null, alias: 'Alias' },
  },
  {
    name: 'authored padding is trimmed out of the resolved values',
    source: '[[ Page # Heading | Alias ]]',
    expected: { target: 'Page', anchor: 'Heading', alias: 'Alias' },
  },
  {
    name: 'anchor may contain further hashes',
    source: '[[a#b#c]]',
    expected: { target: 'a', anchor: 'b#c', alias: null },
  },
  {
    name: 'an all-whitespace target with an alias',
    source: '[[  |alias]]',
    expected: null,
  },
  {
    name: 'an all-whitespace target without a separator',
    source: '[[  ]]',
    expected: null,
  },
  {
    name: 'a target that is only a tab with an alias',
    source: '[[\t|alias]]',
    expected: null,
  },
  {
    name: 'a target that is only a tab without a separator',
    source: '[[\t]]',
    expected: null,
  },
  {
    name: 'an escape-then-whitespace target with an alias',
    source: String.raw`[[\ |alias]]`,
    expected: null,
  },
  {
    name: 'a whitespace-padded escape-then-whitespace target with an alias',
    source: String.raw`[[  \  |alias]]`,
    expected: null,
  },
  {
    name: 'a whitespace-only alias after an escaped separator',
    source: String.raw`[[Page\| ]]`,
    expected: { target: 'Page', anchor: null, alias: null },
  },
  {
    name: 'a whitespace-only alias after an escaped separator behind an anchor',
    source: String.raw`[[Page#head\| ]]`,
    expected: { target: 'Page', anchor: 'head', alias: null },
  },
  {
    name: 'a whitespace-only anchor drops on all paths',
    source: '[[Page# |Alias]]',
    expected: { target: 'Page', anchor: null, alias: 'Alias' },
  },
  {
    name: 'a whitespace-only target before a hash anchor',
    source: '[[ #Heading]]',
    expected: null,
  },
  {
    name: 'a whitespace-only target with an anchor and an alias',
    source: '[[  #a|b]]',
    expected: null,
  },
  {
    name: 'an escape-backslash target before a hash anchor stays a link',
    source: String.raw`[[ \#Heading]]`,
    expected: { target: '\\', anchor: 'Heading', alias: null },
  },
  {
    name: 'embed form of the escaped separator with no anchor',
    source: String.raw`![[Page\|Alias]]`,
    form: 'embed',
    expected: { target: 'Page', anchor: null, alias: 'Alias' },
  },
  {
    name: 'embed form of the escaped separator after an anchor',
    source: String.raw`![[Page#sec\|Alias]]`,
    form: 'embed',
    expected: { target: 'Page', anchor: 'sec', alias: 'Alias' },
  },
  {
    name: 'embed form of the escaped empty-anchor separator',
    source: String.raw`![[Page#\|Alias]]`,
    form: 'embed',
    expected: { target: 'Page', anchor: null, alias: 'Alias' },
  },
  {
    name: 'embed form of escaped separators folded into the alias',
    source: String.raw`![[a\|b\|c]]`,
    form: 'embed',
    expected: { target: 'a', anchor: null, alias: 'b|c' },
  },
  {
    name: 'embed form of a target that is only the separator escape',
    source: String.raw`![[\|alias]]`,
    form: 'embed',
    expected: null,
  },
  {
    name: 'embed form of an all-whitespace target with an alias',
    source: '![[  |alias]]',
    form: 'embed',
    expected: null,
  },
  {
    name: 'embed form of a target that is only a tab with an alias',
    source: '![[\t|alias]]',
    form: 'embed',
    expected: null,
  },
  {
    name: 'embed form of an escape-then-whitespace target with an alias',
    source: String.raw`![[\ |alias]]`,
    form: 'embed',
    expected: null,
  },
  {
    name: 'embed form of a whitespace-only anchor drops on all paths',
    source: '![[Page# |Alias]]',
    form: 'embed',
    expected: { target: 'Page', anchor: null, alias: 'Alias' },
  },
  {
    name: 'a whitespace-only anchor with no alias drops on all paths',
    source: '[[Page# ]]',
    expected: { target: 'Page', anchor: null, alias: null },
  },
];

describe('wiki grammar parity across the three sibling implementations (the core-regex embed leg reuses the link-leg adapter on the !-stripped source; the scanner and micromark embed legs parse the embed form natively)', () => {
  const LEGS = {
    link: [viaServerScanner, viaCoreRegex, viaMicromark] as const,
    embed: [viaServerScannerEmbed, viaCoreRegexEmbed, viaMicromarkEmbed] as const,
  };
  const LEG_TITLES = ['server line scanner', 'core parseWikiLink', 'core micromark parse path'];

  for (const { name, source, form, expected } of FIXTURES) {
    LEGS[form === 'embed' ? 'embed' : 'link'].forEach((via, legIndex) => {
      test(`${name} — ${LEG_TITLES[legIndex]}${form === 'embed' ? ' (embed)' : ''}`, () => {
        expect(via(source)).toEqual(expected);
      });
    });
  }

  test('the three agree with each other, not merely with the fixture table', () => {
    for (const { source, form } of FIXTURES) {
      const [viaServer, viaCore, viaMicro] = LEGS[form === 'embed' ? 'embed' : 'link'];
      const server = viaServer(source);
      const coreRegex = viaCore(source);
      const micromark = viaMicro(source);
      expect({ source, coreRegex }).toEqual({ source, coreRegex: server });
      expect({ source, micromark }).toEqual({ source, micromark: server });
    }
  });
});
