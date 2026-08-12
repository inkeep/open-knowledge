/**
 * Where a source-mode Cmd/Ctrl+click on a `[[wikilink]]` sends you.
 *
 * The destination decision is exercised directly; the surrounding mousedown
 * handler is DOM-layout-bound (`posAtCoords` needs real geometry, which jsdom
 * does not provide) and is covered by Playwright. What is under test here is the
 * part that can be wrong without any geometry: which corpus entry the target
 * names, and therefore which route it opens.
 *
 * Source mode navigates to the raw target and lets the app's hash router run
 * bare-name resolution, so the assertions below pin the route, not the final
 * document — except where the route itself is the defect (an asset route for a
 * document).
 */

import { describe, expect, test } from 'vitest';
import {
  buildSourceWikiLinkLookup,
  type PageItem,
  resolveSourceWikiLinkDestination,
} from './wiki-link-source';

/**
 * The corpus every case resolves against, in the shape `/api/pages` +
 * `/api/documents` actually produce: documents carry `kind:'page'` and no
 * extension, while both referenced assets and tracked files arrive as
 * `kind:'asset'` with a leading slash.
 */
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
      href: '#/acp.daemon',
    });
  });

  test('a dot-free bare name opens a document route', () => {
    expect(resolveSourceWikiLinkDestination('roadmap', null, LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/roadmap',
    });
  });

  test('an anchor rides along on a document route', () => {
    expect(resolveSourceWikiLinkDestination('acp.daemon', 'setup', LOOKUP)).toEqual({
      kind: 'hash',
      href: '#/acp.daemon#setup',
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
