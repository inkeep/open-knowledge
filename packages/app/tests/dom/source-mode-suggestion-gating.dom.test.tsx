import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { setEditorSourceMode } from '../../src/editor/extensions/editor-mode-context';
import { sharedExtensions } from '../../src/editor/extensions/shared';
import { getSuggestionState } from './suggestion-plugin-state.test-helper';

function mountEditor(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content: '<p></p>',
    extensions: sharedExtensions,
    editable: true,
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Source mode suppresses TipTap suggestion plugins (plugin-state contract)', () => {
  afterEach(() => {
    cleanup();
  });

  test('slash command plugin state is inactive in source mode after typing `/`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, true);
      editor.commands.insertContent('/');
      await flush();
      const state = getSuggestionState(editor, 'slashCommand');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
    } finally {
      teardown(editor, container);
    }
  });

  test('wiki-link suggestion plugin state is inactive in source mode after typing `[[`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, true);
      editor.commands.insertContent('[[');
      await flush();
      const state = getSuggestionState(editor, 'wikiLinkSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
    } finally {
      teardown(editor, container);
    }
  });

  test('tag suggestion plugin state is inactive in source mode after typing `#`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, true);
      editor.commands.insertContent(' #');
      await flush();
      const state = getSuggestionState(editor, 'tagSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
    } finally {
      teardown(editor, container);
    }
  });
});

describe('Source mode suppresses TipTap suggestion popup DOM (observable contract)', () => {
  afterEach(() => {
    cleanup();
  });

  test('no suggestion popup is appended to document.body when source mode is active', async () => {
    const { editor, container } = mountEditor();
    const countLeakedChildren = (): number =>
      Array.from(document.body.children).filter((el) => el !== container).length;
    try {
      setEditorSourceMode(editor, true);

      expect(countLeakedChildren()).toBe(0);

      editor.commands.insertContent('/');
      await flush();
      expect(countLeakedChildren()).toBe(0);

      editor.commands.clearContent();
      editor.commands.insertContent('[[');
      await flush();
      expect(countLeakedChildren()).toBe(0);

      editor.commands.clearContent();
      editor.commands.insertContent(' #');
      await flush();
      expect(countLeakedChildren()).toBe(0);

      expect(document.body.querySelectorAll('[role="listbox"]').length).toBe(0);
    } finally {
      teardown(editor, container);
    }
  });
});

describe('WYSIWYG mode activates TipTap suggestion plugins (positive control)', () => {
  afterEach(() => {
    cleanup();
  });

  test('slash command plugin state is active in WYSIWYG mode after typing `/`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, false);
      editor.commands.insertContent('/');
      await flush();
      const state = getSuggestionState(editor, 'slashCommand');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  test('wiki-link suggestion plugin state is active in WYSIWYG mode after typing `[[`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, false);
      editor.commands.insertContent('[[');
      await flush();
      const state = getSuggestionState(editor, 'wikiLinkSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  test('tag suggestion plugin state is active in WYSIWYG mode after typing ` #`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, false);
      editor.commands.insertContent(' #');
      await flush();
      const state = getSuggestionState(editor, 'tagSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  test('slash command is active for an editor that has never had setEditorSourceMode called', async () => {
    const { editor, container } = mountEditor();
    try {
      editor.commands.insertContent('/');
      await flush();
      const state = getSuggestionState(editor, 'slashCommand');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });
});
