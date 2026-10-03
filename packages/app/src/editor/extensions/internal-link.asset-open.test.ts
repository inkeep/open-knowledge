import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { assetPathFromHash } from '../../lib/doc-hash';
import { getInteractionLayer } from '../interaction-layer-host';
import {
  __resetPageListCacheForTests,
  type PageListCacheSnapshot,
  setPageListCache,
} from '../page-list-cache';
import { installDomGlobals } from '../walk-currency-test-harness';
import { InternalLink } from './internal-link';
import { markIdentityKey } from './mark-identity';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

const liveEditors = new Set<Editor>();

beforeEach(() => {
  __resetPageListCacheForTests();
  globalThis.window.location.hash = '';
});

afterEach(() => {
  for (const editor of liveEditors) editor.destroy();
  liveEditors.clear();
  __resetPageListCacheForTests();
});

function cache(opts: {
  assetPaths?: Iterable<string>;
  filePaths?: Iterable<string>;
}): PageListCacheSnapshot {
  return {
    pages: new Set<string>(),
    folderPaths: new Set(['notes']),
    assetPaths: opts.assetPaths === undefined ? undefined : new Set(opts.assetPaths),
    filePaths: opts.filePaths === undefined ? undefined : new Set(opts.filePaths),
    pagesBySlug: new Map(),
  };
}

function mountAssetLink(
  href: string,
  docName: string,
): { activate: (newTab?: boolean) => boolean | undefined } {
  const host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: `<p><a href="${href}">pic</a></p>`,
    extensions: [StarterKit.configure({ link: false }), InternalLink.configure({ docName })],
  });
  liveEditors.add(editor);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));
  const idState = markIdentityKey.getState(editor.state);
  const nodeId = [...(idState?.byId.keys() ?? [])][0];
  if (nodeId === undefined) {
    throw new Error('setup: no link mark id');
  }
  const registration = getInteractionLayer(editor).getRegistration(nodeId);
  if (!registration?.handlePrimary) {
    throw new Error('setup: link did not register a handlePrimary hook');
  }
  return {
    activate: (newTab = false) => registration.handlePrimary?.({ nodeId, type: 'link', newTab }),
  };
}

describe('markdown asset click opens the stored path', () => {
  test('an NFC href opens the NFD file the index stored', () => {
    const stored = 'notes/Caf\u0065\u0301.png';
    setPageListCache(cache({ assetPaths: [stored] }));
    const { activate } = mountAssetLink('./Caf%C3%A9.png', 'notes/index');

    expect(activate()).toBe(true);
    expect(assetPathFromHash(globalThis.window.location.hash)).toBe(stored);
  });

  test('a case-different href opens the stored asset spelling', () => {
    const stored = 'notes/Photo.PNG';
    setPageListCache(cache({ assetPaths: [stored] }));
    const { activate } = mountAssetLink('./photo.png', 'notes/index');

    expect(activate()).toBe(true);
    expect(assetPathFromHash(globalThis.window.location.hash)).toBe(stored);
  });

  test('an NFC href opens an NFD path that lives only in the file index', () => {
    const stored = 'notes/Caf\u0065\u0301.csv';
    setPageListCache(cache({ assetPaths: [], filePaths: [stored] }));
    const { activate } = mountAssetLink('./Caf%C3%A9.csv', 'notes/index');

    expect(activate()).toBe(true);
    expect(assetPathFromHash(globalThis.window.location.hash)).toBe(stored);
  });

  test('exact stored bytes win when both compositions are indexed', () => {
    const nfc = 'notes/Caf\u00E9.png';
    const nfd = 'notes/Caf\u0065\u0301.png';
    setPageListCache(cache({ assetPaths: [nfd, nfc] }));
    const { activate } = mountAssetLink('./Caf%C3%A9.png', 'notes/index');

    expect(activate()).toBe(true);
    expect(assetPathFromHash(globalThis.window.location.hash)).toBe(nfc);
  });
});
