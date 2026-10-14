import { cleanup } from '@testing-library/react';
import type { Extensions } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import type { Plugin, PluginKey } from '@tiptap/pm/state';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  composerMentionExtensions,
  composerMentionSuggestionKey,
} from '../composer-mention/composer-mention';
import {
  composerSlashSuggestionKey,
  type SlashCommandItem,
} from '../composer-mention/composer-slash-command';
import { sharedExtensions } from './shared';

interface SuggestionState {
  active: boolean;
  query: string | null;
  text: string | null;
  range: { from: number; to: number };
}

const COMMANDS: SlashCommandItem[] = [
  { name: 'review', description: 'Review the current diff' },
  { name: 'create_plan', description: 'Draft an implementation plan' },
];

function fetchResponse(status: number, body: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubCorpusFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      if (String(input).includes('/api/pages')) {
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

function editorSlashPlugin(editor: Editor): Plugin | undefined {
  return editor.state.plugins.find((p) => {
    const keyName = (p as { spec?: { key?: { key?: string } } }).spec?.key?.key;
    return typeof keyName === 'string' && keyName.startsWith('slashCommand');
  });
}

function editorSlashState(editor: Editor): SuggestionState | null {
  return (editorSlashPlugin(editor)?.getState(editor.state) as SuggestionState | undefined) ?? null;
}

function stateOf(editor: Editor, key: PluginKey): SuggestionState | null {
  return (key.getState(editor.state) as SuggestionState | undefined) ?? null;
}

function pressEnterOnSuggestion(editor: Editor, plugin: Plugin | undefined): boolean {
  const handleKeyDown = plugin?.props.handleKeyDown;
  if (!plugin || !handleKeyDown) return false;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return handleKeyDown.call(plugin, editor.view, event) === true;
}

async function pressEnterOnceItemsLoad(
  editor: Editor,
  plugin: (editor: Editor) => Plugin | undefined,
): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (pressEnterOnSuggestion(editor, plugin(editor))) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

function startComposition(editor: Editor): void {
  editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
}

function composeText(editor: Editor, text: string): void {
  editor.view.dispatch(editor.state.tr.insertText(text));
}

function endComposition(editor: Editor, data: string): void {
  editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Surface {
  name: string;
  extensions: () => Extensions;
  state: (editor: Editor) => SuggestionState | null;
  ascii: string;
  fullWidth: string;
}

const SURFACES: Surface[] = [
  {
    name: 'composer @ mention',
    extensions: () => composerMentionExtensions(),
    state: (editor) => stateOf(editor, composerMentionSuggestionKey),
    ascii: '@',
    fullWidth: '\uff20',
  },
  {
    name: 'composer / command',
    extensions: () => composerMentionExtensions({ slashCommands: COMMANDS }),
    state: (editor) => stateOf(editor, composerSlashSuggestionKey),
    ascii: '/',
    fullWidth: '\uff0f',
  },
  {
    name: 'editor / menu',
    extensions: () => sharedExtensions,
    state: editorSlashState,
    ascii: '/',
    fullWidth: '\uff0f',
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(SURFACES)('$name with a Japanese input method', (surface) => {
  async function typeAndRead(text: string): Promise<SuggestionState | null> {
    stubCorpusFetch();
    const { editor, container } = mountEditor(surface.extensions());
    try {
      editor.commands.focus('end');
      editor.commands.insertContent(text);
      await settle();
      return surface.state(editor);
    } finally {
      teardown(editor, container);
    }
  }

  test('the ASCII trigger after an ideographic space opens the menu', async () => {
    const state = await typeAndRead(`メモ\u3000${surface.ascii}re`);
    expect(state?.active).toBe(true);
    expect(state?.query).toBe('re');
  });

  test('the full-width trigger opens the menu at the start of a line', async () => {
    const state = await typeAndRead(`${surface.fullWidth}re`);
    expect(state?.active).toBe(true);
    expect(state?.query).toBe('re');
    expect(state?.text).toBe(`${surface.fullWidth}re`);
  });

  test('the full-width trigger after an ideographic space opens the menu', async () => {
    const state = await typeAndRead(`メモ\u3000${surface.fullWidth}`);
    expect(state?.active).toBe(true);
    expect(state?.query).toBe('');
  });

  test('a full-width trigger glued to a preceding word stays prose, like the ASCII one', async () => {
    expect((await typeAndRead(`and${surface.ascii}or`))?.active).toBeFalsy();
    expect((await typeAndRead(`and${surface.fullWidth}or`))?.active).toBeFalsy();
  });

  test('a second trigger glued into the query closes the menu, whichever width either is', async () => {
    expect((await typeAndRead(`${surface.ascii}re${surface.ascii}x`))?.active).toBeFalsy();
    expect((await typeAndRead(`${surface.fullWidth}re${surface.ascii}x`))?.active).toBeFalsy();
    expect((await typeAndRead(`${surface.ascii}re${surface.fullWidth}x`))?.active).toBeFalsy();
  });

  test('the query stops at an ideographic space', async () => {
    expect((await typeAndRead(`${surface.fullWidth}re\u3000x`))?.active).toBeFalsy();
  });

  test.each([
    ['full-width', 'メモ\u3000', surface.fullWidth],
    ['ASCII', 'memo ', surface.ascii],
  ])(
    'a %s trigger composed by the IME opens no menu until the composition commits',
    async (_label, prefix, trigger) => {
      stubCorpusFetch();
      const { editor, container } = mountEditor(surface.extensions());
      try {
        editor.commands.focus('end');
        editor.commands.insertContent(prefix);
        startComposition(editor);
        composeText(editor, trigger);
        await settle();
        expect(editor.view.composing).toBe(true);
        expect(surface.state(editor)?.active).toBeFalsy();

        endComposition(editor, trigger);
        await settle();
        expect(editor.view.composing).toBe(false);
        expect(surface.state(editor)?.active).toBe(true);
      } finally {
        teardown(editor, container);
      }
    },
  );

  test('an open menu keeps filtering while the IME composes its query', async () => {
    stubCorpusFetch();
    const { editor, container } = mountEditor(surface.extensions());
    try {
      editor.commands.focus('end');
      editor.commands.insertContent(surface.ascii);
      await settle();
      expect(surface.state(editor)?.active).toBe(true);

      startComposition(editor);
      composeText(editor, 'れ');
      await settle();
      expect(surface.state(editor)?.active).toBe(true);
      expect(surface.state(editor)?.query).toBe('れ');
    } finally {
      teardown(editor, container);
    }
  });
});

describe('picking an item replaces the full-width trigger like the ASCII one', () => {
  test('composer @ mention: the mention chip replaces \uff20 and its query', async () => {
    stubCorpusFetch();
    const { editor, container } = mountEditor(composerMentionExtensions());
    try {
      editor.commands.focus('end');
      editor.commands.insertContent('見て\u3000\uff20alp');
      expect(
        await pressEnterOnceItemsLoad(editor, (e) => composerMentionSuggestionKey.get(e.state)),
      ).toBe(true);
      let mentions = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'composerMention') mentions += 1;
      });
      expect(mentions).toBe(1);
      expect(editor.state.doc.textContent).toBe('見て\u3000 ');
    } finally {
      teardown(editor, container);
    }
  });

  test('composer / command at message start: \uff0frev becomes the /review pill', async () => {
    const { editor, container } = mountEditor(
      composerMentionExtensions({ slashCommands: COMMANDS }),
    );
    try {
      editor.commands.focus('end');
      editor.commands.insertContent('\uff0frev');
      expect(
        await pressEnterOnceItemsLoad(editor, (e) => composerSlashSuggestionKey.get(e.state)),
      ).toBe(true);
      const lead = editor.state.doc.firstChild?.firstChild;
      expect(lead?.type.name).toBe('composerCommand');
      expect(lead?.attrs.name).toBe('review');
      expect(editor.state.doc.textContent).not.toContain('\uff0f');
    } finally {
      teardown(editor, container);
    }
  });

  test('composer / command mid-message: \uff0frev completes to plain /review', async () => {
    const { editor, container } = mountEditor(
      composerMentionExtensions({ slashCommands: COMMANDS }),
    );
    try {
      editor.commands.focus('end');
      editor.commands.insertContent('見て\u3000\uff0frev');
      expect(
        await pressEnterOnceItemsLoad(editor, (e) => composerSlashSuggestionKey.get(e.state)),
      ).toBe(true);
      expect(editor.state.doc.textContent).toBe('見て\u3000/review ');
    } finally {
      teardown(editor, container);
    }
  });

  test('editor / menu: picking a heading consumes \uff0f and its query', async () => {
    const { editor, container } = mountEditor(sharedExtensions);
    try {
      editor.commands.focus('end');
      editor.commands.insertContent('\uff0fheading1');
      expect(await pressEnterOnceItemsLoad(editor, editorSlashPlugin)).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe('heading');
      expect(editor.state.doc.textContent).toBe('');
    } finally {
      teardown(editor, container);
    }
  });
});
