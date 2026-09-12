/**
 * One-transaction pin for every non-slash `@tiptap/suggestion` surface (precedent #58): tag,
 * wiki-link and the Ask-AI `@`-mention each land trigger delete and insert as one transaction.
 */

import { cleanup } from '@testing-library/react';
import type { Extensions } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import type { PluginKey } from '@tiptap/pm/state';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  composerMentionExtensions,
  composerMentionSuggestionKey,
} from '../composer-mention/composer-mention';
import { sharedExtensions } from './shared';
import { tagSuggestionKey } from './tag-suggestion';
import { wikiLinkSuggestionKey } from './wiki-link-suggestion';

function fetchResponse(status: number, body: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubCorpusFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return fetchResponse(200, { tags: [{ name: 'alpha', count: 3, isLeaf: true }] });
      }
      if (url.includes('/api/pages')) {
        return fetchResponse(200, {
          pages: [
            {
              docName: 'alpha',
              title: 'Alpha',
              docExt: '.md',
              size: 1,
              modified: '2026-01-01T00:00:00.000Z',
            },
          ],
        });
      }
      return fetchResponse(404, {});
    }),
  );
}

function mountEditor(extensions: Extensions): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions,
    editable: true,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  return { editor, container };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
  for (const node of Array.from(document.body.children)) {
    if (node !== container) node.remove();
  }
}

function pressEnterOnSuggestion(editor: Editor, pluginKey: PluginKey): boolean {
  const plugin = pluginKey.get(editor.state);
  const handleKeyDown = plugin?.props.handleKeyDown;
  if (!plugin || !handleKeyDown) return false;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return handleKeyDown.call(plugin, editor.view, event) === true;
}

async function pressEnterOnceItemsLoad(editor: Editor, pluginKey: PluginKey): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (pressEnterOnSuggestion(editor, pluginKey)) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

interface SurfaceCase {
  name: string;
  extensions: () => Extensions;
  pluginKey: PluginKey;
  trigger: string;
  insertedNodeType: string;
}

const SURFACES: SurfaceCase[] = [
  {
    name: 'tag suggestion (#)',
    extensions: () => sharedExtensions,
    pluginKey: tagSuggestionKey,
    trigger: '#alp',
    insertedNodeType: 'tag',
  },
  {
    name: 'wiki-link suggestion ([[)',
    extensions: () => sharedExtensions,
    pluginKey: wikiLinkSuggestionKey,
    trigger: '[[alp',
    insertedNodeType: 'wikiLink',
  },
  {
    name: 'composer mention (@)',
    extensions: () => composerMentionExtensions(),
    pluginKey: composerMentionSuggestionKey,
    trigger: '@alp',
    insertedNodeType: 'composerMention',
  },
];

function countNodesOfType(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1;
  });
  return count;
}

describe('Suggestion-surface insertion is a single transaction', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  for (const surface of SURFACES) {
    test(`${surface.name}: selecting an item dispatches exactly one doc-changing transaction`, async () => {
      stubCorpusFetch();
      const { editor, container } = mountEditor(surface.extensions());
      try {
        editor.commands.focus('end');
        editor.commands.insertContent(surface.trigger);

        let docChangingCount = 0;
        editor.on('transaction', ({ transaction }) => {
          if (transaction.docChanged) docChangingCount += 1;
        });

        expect(await pressEnterOnceItemsLoad(editor, surface.pluginKey)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(countNodesOfType(editor, surface.insertedNodeType)).toBe(1);
        expect(editor.state.doc.textContent).not.toContain(surface.trigger);

        expect(docChangingCount).toBe(1);
      } finally {
        teardown(editor, container);
      }
    });
  }
});
