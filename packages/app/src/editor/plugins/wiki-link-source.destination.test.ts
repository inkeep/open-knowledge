import { describe, expect, test } from 'vitest';
import type { PageItem } from '../extensions/wiki-link-suggestion';
import { buildSourceWikiLinkLookup, resolveSourceWikiLinkDestination } from './wiki-link-source';

const CORPUS: PageItem[] = [
  { kind: 'page', docName: 'index', title: 'Home' },
  { kind: 'page', docName: 'notes/acp.daemon', title: 'ACP daemon' },
  { kind: 'page', docName: 'notes/roadmap', title: 'Roadmap' },
  { kind: 'asset', docName: '/files/meeting.pdf', title: 'meeting.pdf' },
  { kind: 'folder', docName: 'notes', title: 'notes' },
];

const LOOKUP = buildSourceWikiLinkLookup(CORPUS);

describe('source-mode wiki-link destination', () => {
  test('a target naming a dotted-filename document opens a document route', () => {
    expect(resolveSourceWikiLinkDestination('acp.daemon', null, LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/notes/acp.daemon',
    });
  });

  test('a dot-free bare name opens a document route', () => {
    expect(resolveSourceWikiLinkDestination('roadmap', null, LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/notes/roadmap',
    });
  });

  test('an anchor rides along on a document route', () => {
    expect(resolveSourceWikiLinkDestination('acp.daemon', 'setup', LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/notes/acp.daemon#setup',
    });
  });

  test('a target naming a real asset opens the asset viewer at its indexed path', () => {
    expect(resolveSourceWikiLinkDestination('meeting.pdf', null, LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/__asset__/files/meeting.pdf',
    });
  });

  test('a target naming nothing at all still opens the asset viewer', () => {
    expect(resolveSourceWikiLinkDestination('absent.pdf', null, LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/__asset__/absent.pdf',
    });
  });

  test('an external target is handed to the external opener, not a hash route', () => {
    expect(resolveSourceWikiLinkDestination('https://example.com/docs', null, LOOKUP)).toEqual({
      kind: 'external',
      url: 'https://example.com/docs',
    });
  });

  test('an empty target names nothing to open', () => {
    expect(resolveSourceWikiLinkDestination('   ', null, LOOKUP)).toBeNull();
  });
});

describe('buildSourceWikiLinkLookup', () => {
  test('folders are not documents', () => {
    expect(LOOKUP.pages.has('notes')).toBe(false);
    expect(LOOKUP.pages.has('notes/roadmap')).toBe(true);
  });

  test('asset paths drop the leading slash the documents API adds', () => {
    expect(LOOKUP.assetPaths?.has('files/meeting.pdf')).toBe(true);
  });
});

describe('source destination preserves Markdown target identity', () => {
  const lookup = buildSourceWikiLinkLookup([
    { docName: 'notes/beta', title: 'Beta' },
    { docName: 'notes/beta-md', title: 'Other' },
    { docName: 'x', title: 'X' },
    { docName: 'x.md', title: 'Dotted X' },
    { docName: 'reports/index', title: 'Reports' },
    { docName: 'fallback-md', title: 'Fallback' },
  ]);

  test.each([
    ['notes/beta.md', 'notes/beta'],
    ['NOTES/BETA.MDX', 'notes/beta'],
    ['beta.md', 'notes/beta'],
    ['x.md', 'x.md'],
    ['x.md.md', 'x.md'],
    ['reports.md', 'reports/index'],
    ['fallback.md', 'fallback-md'],
  ])('%s routes to %s with its heading', (target, expected) => {
    expect(resolveSourceWikiLinkDestination(target, 'setup', lookup)).toEqual({
      kind: 'hash',
      href: `#/${expected}#setup`,
    });
  });
});
