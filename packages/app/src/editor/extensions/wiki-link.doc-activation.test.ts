import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getInteractionLayer } from '../interaction-layer-host';
import {
  __resetPageListCacheForTests,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  setPageListCache,
} from '../page-list-cache';
import { installDomGlobals } from '../walk-currency-test-harness';
import { WikiLink } from './wiki-link';
import { toWikiLinkSlug } from './wiki-link-helpers';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

const liveEditors = new Set<Editor>();

const PAGES = new Set(['index', 'notes/acp.daemon', 'notes/roadmap']);
const ASSET_PATHS = new Set(['files/meeting.pdf']);

beforeEach(() => {
  __resetPageListCacheForTests();
  setPageListCache({
    pages: PAGES,
    folderPaths: new Set(['notes', 'files']),
    assetPaths: ASSET_PATHS,
    pagesBySlug: buildPagesBySlugIndex(PAGES, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(PAGES, toWikiLinkSlug),
  });
  globalThis.window.location.hash = '';
});

afterEach(() => {
  for (const editor of liveEditors) editor.destroy();
  liveEditors.clear();
  __resetPageListCacheForTests();
});

function mountWikiLink(target: string): {
  activate: (newTab?: boolean) => boolean | undefined;
  currentHash: () => string;
} {
  const host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: `<p><span data-wiki-link data-target="${target}"></span></p>`,
    extensions: [StarterKit, WikiLink.configure({ docName: 'index' })],
  });
  liveEditors.add(editor);

  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

  const chip = host.querySelector('[data-node-id]');
  const nodeId = chip?.getAttribute('data-node-id') ?? undefined;
  if (nodeId === undefined) {
    throw new Error(`setup: no wiki-link chip parsed for target ${target}`);
  }
  const registration = getInteractionLayer(editor).getRegistration(nodeId);
  if (!registration?.handlePrimary) {
    throw new Error('setup: wiki-link chip did not register a handlePrimary hook');
  }
  return {
    activate: (newTab = false) =>
      registration.handlePrimary?.({ nodeId, type: 'wikiLink', newTab }),
    currentHash: () => globalThis.window.location.hash,
  };
}

describe('WYSIWYG wiki-link activation', () => {
  test('a target naming a dotted-filename document opens that document', () => {
    const { activate, currentHash } = mountWikiLink('acp.daemon');

    expect(activate()).toBe(true);
    expect(currentHash()).toBe('#/notes/acp.daemon');
  });

  test('a dot-free bare name still opens its subfolder document', () => {
    const { activate, currentHash } = mountWikiLink('roadmap');

    expect(activate()).toBe(true);
    expect(currentHash()).toBe('#/notes/roadmap');
  });

  test('a target naming an existing folder opens the folder view (PRD-7956)', () => {
    const { activate, currentHash } = mountWikiLink('notes');

    expect(activate()).toBe(true);
    expect(currentHash()).toBe('#/notes');
  });

  test('a target naming a missing page still falls through to create (returns false)', () => {
    const { activate, currentHash } = mountWikiLink('totally/absent-page');

    expect(activate()).toBe(false);
    expect(currentHash()).toBe('');
  });

  test('a target naming a real asset still opens the asset viewer', () => {
    const { activate, currentHash } = mountWikiLink('meeting.pdf');

    expect(activate()).toBe(true);
    expect(currentHash()).toBe('#/__asset__/files/meeting.pdf');
  });

  test('a target naming nothing at all still routes to the asset viewer', () => {
    const { activate, currentHash } = mountWikiLink('absent.pdf');

    expect(activate()).toBe(true);
    expect(currentHash()).toBe('#/__asset__/absent.pdf');
  });
});
