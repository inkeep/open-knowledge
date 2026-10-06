import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { getInteractionLayer } from '../interaction-layer-host';
import {
  __resetPageListCacheForTests,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  setPageListCache,
} from '../page-list-cache';
import { installDomGlobals } from '../walk-currency-test-harness';
import { InternalLink } from './internal-link';
import { markIdentityKey } from './mark-identity';
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

const PAGES = new Set(['NonMd', 'docs/guide']);

beforeEach(() => {
  __resetPageListCacheForTests();
  setPageListCache({
    pages: PAGES,
    folderPaths: new Set(['docs', 'media']),
    assetPaths: new Set(['media/photo.png']),
    filePaths: new Set(['docs/Makefile', 'docs/script.py']),
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

function mountLink(href: string): {
  activate: (newTab?: boolean) => boolean | undefined;
  currentHash: () => string;
} {
  const host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: `<p><a href="${href}">go</a></p>`,
    extensions: [
      StarterKit.configure({ link: false }),
      InternalLink.configure({ docName: 'NonMd' }),
    ],
  });
  liveEditors.add(editor);

  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

  const nodeId = [...(markIdentityKey.getState(editor.state)?.byId.keys() ?? [])][0];
  if (nodeId === undefined) {
    throw new Error(`setup: no link mark id parsed for href ${href}`);
  }
  const registration = getInteractionLayer(editor).getRegistration(nodeId);
  if (!registration?.handlePrimary) {
    throw new Error('setup: link mark did not register a handlePrimary hook');
  }
  return {
    activate: (newTab = false) => registration.handlePrimary?.({ nodeId, type: 'link', newTab }),
    currentHash: () => globalThis.window.location.hash,
  };
}

describe('WYSIWYG markdown link to a tracked file with no page behind it', () => {
  test('a plain click on a link to an extensionless tracked file opens the file preview', () => {
    const { activate, currentHash } = mountLink('docs/Makefile');

    expect(activate(false)).toBe(true);
    expect(currentHash()).toBe('#/__asset__/docs/Makefile');
  });

  test('a Cmd/Ctrl click on a link to an extensionless tracked file opens the preview in a new app tab', async () => {
    const open = vi.fn(() => null);
    const w = globalThis.window as unknown as { open: unknown };
    const originalOpen = w.open;
    w.open = open;
    try {
      const { activate, currentHash } = mountLink('docs/Makefile');

      expect(activate(true)).toBe(true);
      await Promise.resolve();
      expect(open).toHaveBeenCalledWith(
        '#/__asset__/docs/Makefile',
        '_blank',
        'noopener,noreferrer',
      );
      expect(currentHash()).toBe('');
    } finally {
      w.open = originalOpen;
    }
  });

  test('a link to a missing extensionless path still falls through to create (returns false)', () => {
    const { activate, currentHash } = mountLink('docs/absent');

    expect(activate(false)).toBe(false);
    expect(currentHash()).toBe('');
  });

  test('a link to an existing page keeps opening the page', () => {
    const { activate, currentHash } = mountLink('docs/guide');

    expect(activate(false)).toBe(true);
    expect(currentHash()).toBe('#/docs/guide');
  });
});
