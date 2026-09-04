import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Content, JSONContent } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileEntryPathIconToSvgString } from '@/components/file-entry-icon';
import { getEditorForDoc, registerEditor, unregisterEditor } from './active-editor';
import { ComposerMentionInput, type ComposerMentionInputHandle } from './ComposerMentionInput';
import {
  composerMentionExtensions,
  composerMentionSuggestionKey,
  isComposerEmpty,
  serializeComposerContent,
} from './composer-mention/composer-mention';
import { suggestionHasSelectableItem } from './extensions/suggestion-floating-ui';

function makeEditor(content?: Content) {
  return new Editor({ extensions: composerMentionExtensions(), content });
}

function paragraph(...inline: Content[]) {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] } as Content;
}

function mentionNode(path: string, label = path): Content {
  return { type: 'composerMention', attrs: { path, label } };
}

function getComposerEditor(box: HTMLElement): Editor {
  return (box as unknown as { editor: Editor }).editor;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
});

describe('serializeComposerContent / isComposerEmpty', () => {
  test('an empty editor is empty and serializes to nothing', () => {
    const editor = makeEditor();
    try {
      expect(isComposerEmpty(editor)).toBe(true);
      expect(serializeComposerContent(editor)).toEqual({
        instruction: '',
        mentions: [],
        attachments: [],
      });
    } finally {
      editor.destroy();
    }
  });

  test('a chip serializes inline as @path and rides the mentions list', () => {
    const editor = makeEditor(
      paragraph({ type: 'text', text: 'summarize ' }, mentionNode('notes.md', 'Notes'), {
        type: 'text',
        text: ' please',
      }),
    );
    try {
      const { instruction, mentions } = serializeComposerContent(editor);
      expect(instruction).toBe('summarize @notes.md please');
      expect(mentions).toEqual(['notes.md']);
      expect(isComposerEmpty(editor)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  test('repeated mentions of the same doc de-duplicate (first-occurrence order)', () => {
    const editor = makeEditor(
      paragraph(mentionNode('notes.md'), { type: 'text', text: ' and ' }, mentionNode('notes.md')),
    );
    try {
      const { instruction, mentions } = serializeComposerContent(editor);
      expect(instruction).toBe('@notes.md and @notes.md');
      expect(mentions).toEqual(['notes.md']);
    } finally {
      editor.destroy();
    }
  });

  test('distinct mentions preserve document order', () => {
    const editor = makeEditor(
      paragraph(
        mentionNode('specs/a.md'),
        { type: 'text', text: ' vs ' },
        mentionNode('specs/b.md'),
      ),
    );
    try {
      expect(serializeComposerContent(editor).mentions).toEqual(['specs/a.md', 'specs/b.md']);
    } finally {
      editor.destroy();
    }
  });

  test('a picked command pill serializes to /name and counts as content on EVERY surface', () => {
    const editor = makeEditor(
      paragraph(
        { type: 'composerCommand', attrs: { name: 'review', description: '', hint: '' } },
        { type: 'text', text: ' the diff' },
      ),
    );
    try {
      expect(serializeComposerContent(editor)).toEqual({
        instruction: '/review the diff',
        mentions: [],
        attachments: [],
      });
      expect(isComposerEmpty(editor)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  test('plain prose carries no mentions', () => {
    const editor = makeEditor(paragraph({ type: 'text', text: 'just words' }));
    try {
      expect(serializeComposerContent(editor)).toEqual({
        instruction: 'just words',
        mentions: [],
        attachments: [],
      });
    } finally {
      editor.destroy();
    }
  });
});

describe('ComposerMentionInput (component)', () => {
  test('renders an accessible textbox with the given name', () => {
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={() => {}} />,
    );
    expect(screen.getByRole('textbox', { name: 'Ask AI' })).toBeTruthy();
  });

  test('Enter calls onSubmit; Shift+Enter does not', () => {
    const onSubmit = vi.fn(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(0);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('focusEnd places the caret at the end of the draft', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Ask AI"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        initialDoc={paragraph({ type: 'text', text: 'draft text' }) as JSONContent}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);
    ref.current?.focusEnd();
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  });

  test('setText replaces the field with plain text (read back via getContent)', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    const onEmptyChange = vi.fn((_isEmpty: boolean) => {});
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Describe"
        onEmptyChange={onEmptyChange}
        onSubmit={() => {}}
      />,
    );
    ref.current?.setText('a research wiki');
    expect(ref.current?.getContent()).toEqual({
      instruction: 'a research wiki',
      mentions: [],
      attachments: [],
    });
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
  });

  test('setText announces emptiness when it clears the field', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    const onEmptyChange = vi.fn((_isEmpty: boolean) => {});
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Describe"
        onEmptyChange={onEmptyChange}
        onSubmit={() => {}}
      />,
    );
    ref.current?.setText('something');
    ref.current?.setText('');
    expect(onEmptyChange).toHaveBeenLastCalledWith(true);
  });

  test('appendText fills an empty field, mapping newlines to paragraphs', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    const onEmptyChange = vi.fn((_isEmpty: boolean) => {});
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Claude"
        onEmptyChange={onEmptyChange}
        onSubmit={() => {}}
      />,
    );
    ref.current?.appendText('line one\nline two');
    expect(ref.current?.getContent().instruction).toBe('line one\nline two');
    expect(onEmptyChange).toHaveBeenLastCalledWith(false);
  });

  test('appendText joins after existing content with a blank line, chips intact', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Claude"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        initialDoc={
          paragraph(
            { type: 'text', text: 'look at ' },
            mentionNode('notes.md', 'Notes'),
          ) as JSONContent
        }
      />,
    );
    ref.current?.appendText('rescued queue text');
    const { instruction, mentions } = ref.current?.getContent() ?? {
      instruction: '',
      mentions: [],
    };
    expect(instruction).toBe('look at @notes.md\n\nrescued queue text');
    expect(mentions).toEqual(['notes.md']);
  });

  test('disabled turns off editing but keeps content, placeholder, and the handle', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    const { rerender } = render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Claude"
        placeholder="Resuming the chat"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        disabled
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Message Claude' });
    expect(box.getAttribute('contenteditable')).toBe('false');
    expect(box.getAttribute('aria-disabled')).toBe('true');
    expect(box.querySelector('[data-placeholder="Resuming the chat"]')).not.toBeNull();
    ref.current?.appendText('kept');
    expect(ref.current?.getContent().instruction).toBe('kept');

    rerender(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Claude"
        placeholder="Resuming the chat"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(box.getAttribute('contenteditable')).toBe('true');
    expect(box.getAttribute('aria-disabled')).toBeNull();
    expect(ref.current?.getContent().instruction).toBe('kept');
  });

  test('mounting emits no onContentChange — only an edit mirrors into the draft', () => {
    const onContentChange = vi.fn(() => {});
    render(
      <ComposerMentionInput
        ariaLabel="Ask AI"
        onEmptyChange={() => {}}
        onContentChange={onContentChange}
        onSubmit={() => {}}
      />,
    );
    expect(onContentChange).not.toHaveBeenCalled();
  });

  test('a placeholder adds the data-placeholder hint while the field is empty', () => {
    render(
      <ComposerMentionInput
        ariaLabel="Describe"
        placeholder="A wiki"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Describe' });
    expect(box.querySelector('[data-placeholder="A wiki"]')).not.toBeNull();
  });

  test('an inline @-mention chip exposes a leading icon-button that removes the node', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Ask AI"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        initialDoc={paragraph(mentionNode('notes.md', 'Notes')) as JSONContent}
      />,
    );
    const removeBtn = screen.getByRole('button', { name: /Remove Notes/i });
    expect(removeBtn).toBeTruthy();
    const chip = removeBtn.closest('.composer-mention-chip');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('title')).toBe('Notes');
    expect(chip?.querySelector('.composer-mention-label')?.textContent).toBe('Notes');
    expect(removeBtn.classList.contains('composer-mention-icon')).toBe(true);
    expect(removeBtn.matches('.composer-mention-chip > .composer-mention-icon:first-child')).toBe(
      true,
    );
    expect(chip?.querySelector('.composer-mention-remove')).toBeNull();
    const restIcon = removeBtn.querySelector('.composer-mention-glyph-icon');
    const hoverIcon = removeBtn.querySelector('.composer-mention-glyph-x');
    expect(restIcon?.querySelector('svg')).not.toBeNull();
    expect(hoverIcon?.querySelector('svg')).not.toBeNull();
    expect(restIcon?.textContent).not.toContain('@');
    expect(hoverIcon?.textContent).not.toContain('×');
    const restSvg = restIcon?.querySelector('svg');
    expect(restSvg?.getAttribute('fill')).toBe('currentColor');
    expect(ref.current?.getContent().mentions).toEqual(['notes.md']);

    fireEvent.click(removeBtn);
    expect(ref.current?.getContent().mentions).toEqual([]);
    expect(screen.queryByRole('button', { name: /Remove Notes/i })).toBeNull();
  });

  test('the inline chip resting glyph is the type-aware file-entry icon for the path', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Ask AI"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        initialDoc={
          paragraph(
            mentionNode('specs/foo', 'foo'),
            { type: 'text', text: ' ' },
            mentionNode('notes.md', 'Notes'),
            { type: 'text', text: ' ' },
            mentionNode('clips/demo.mp4', 'Demo'),
          ) as JSONContent
        }
      />,
    );
    const normalizeSvg = (markup: string | undefined) => {
      const host = document.createElement('div');
      host.innerHTML = markup ?? '';
      return host.querySelector('svg')?.outerHTML;
    };
    const folderBtn = screen.getByRole('button', { name: /Remove foo from context/i });
    const folderSvg = folderBtn
      .querySelector('.composer-mention-glyph-icon')
      ?.querySelector('svg')?.outerHTML;
    expect(folderSvg).toBeDefined();
    expect(folderSvg).toBe(normalizeSvg(fileEntryPathIconToSvgString('specs/foo')));

    const pageBtn = screen.getByRole('button', { name: /Remove Notes from context/i });
    const pageSvg = pageBtn
      .querySelector('.composer-mention-glyph-icon')
      ?.querySelector('svg')?.outerHTML;
    expect(pageSvg).toBeDefined();
    expect(pageSvg).toBe(normalizeSvg(fileEntryPathIconToSvgString('notes.md')));

    const videoBtn = screen.getByRole('button', { name: /Remove Demo from context/i });
    const videoSvg = videoBtn
      .querySelector('.composer-mention-glyph-icon')
      ?.querySelector('svg')?.outerHTML;
    expect(videoSvg).toBeDefined();
    expect(videoSvg).toBe(normalizeSvg(fileEntryPathIconToSvgString('clips/demo.mp4')));

    expect(folderSvg).not.toBe(pageSvg);
  });

  test('mounting does NOT register in the active-editor registry', () => {
    const docEditor = makeEditor();
    registerEditor('some-doc', docEditor);
    try {
      render(
        <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={() => {}} />,
      );
      expect(getEditorForDoc('some-doc')).toBe(docEditor);
    } finally {
      unregisterEditor('some-doc', docEditor);
      docEditor.destroy();
    }
  });
});

describe('ComposerMentionInput — Enter defers to the @-mention popup', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            pages: [
              {
                docName: 'foo',
                title: 'Foo',
                docExt: '.md',
                size: 1,
                modified: '2026-01-01T00:00:00.000Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function isSuggestionActive(editor: Editor): boolean {
    const state = composerMentionSuggestionKey.getState(editor.state) as
      | { active: boolean }
      | undefined;
    return state?.active ?? false;
  }

  async function waitForSelectableItem(editor: Editor): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (suggestionHasSelectableItem(editor.view)) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('mention popup never produced a selectable item');
  }

  test('Enter submits while the popup is closed', () => {
    const onSubmit = vi.fn(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    expect(isSuggestionActive(editor)).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('Enter does NOT submit while the @-popup holds a selectable item', async () => {
    const onSubmit = vi.fn(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    editor.commands.insertContent('@foo');
    expect(isSuggestionActive(editor)).toBe(true);
    await waitForSelectableItem(editor);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  test('Enter over an open @-popup with NO selectable item submits — never splits', async () => {
    const onSubmit = vi.fn(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    editor.commands.insertContent('@zzz');
    expect(isSuggestionActive(editor)).toBe(true);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(editor.state.doc.childCount).toBe(1);
  });

  test('Enter resumes submitting once the popup closes', async () => {
    const onSubmit = vi.fn(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    editor.commands.insertContent('@foo');
    expect(isSuggestionActive(editor)).toBe(true);
    await waitForSelectableItem(editor);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(0);

    editor.commands.clearContent(true);
    expect(isSuggestionActive(editor)).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('Escape defers to the open @-popup and does not fire onEscape', () => {
    const onEscape = vi.fn(() => {});
    render(
      <ComposerMentionInput
        ariaLabel="Ask AI"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        onEscape={onEscape}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    editor.commands.insertContent('@foo');
    expect(isSuggestionActive(editor)).toBe(true);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(0);

    editor.commands.clearContent(true);
    expect(isSuggestionActive(editor)).toBe(false);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe('ComposerMentionInput — Enter during IME composition', () => {
  test('neither guard half lets a composition Enter submit; a plain Enter does', () => {
    const onSubmit = vi.fn(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSubmit).toHaveBeenCalledTimes(0);

    Object.defineProperty(editor.view, 'composing', { get: () => true, configurable: true });
    try {
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledTimes(0);
    } finally {
      Reflect.deleteProperty(editor.view, 'composing');
    }

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('ComposerMentionInput — setText round-trips the text it was given', () => {
  test('newlines survive, and angle brackets are not parsed as markup', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    render(<ComposerMentionInput ref={ref} ariaLabel="Ask AI" onEmptyChange={() => {}} />);

    const seeded = 'first line\nsecond <b>line</b>\n\nfourth line';
    act(() => ref.current?.setText(seeded));

    expect(ref.current?.getContent().instruction).toBe(seeded);
  });

  test('seeding announces emptiness, the way appending does', () => {
    const onEmptyChange = vi.fn((_isEmpty: boolean) => {});
    const ref = createRef<ComposerMentionInputHandle>();
    render(<ComposerMentionInput ref={ref} ariaLabel="Ask AI" onEmptyChange={onEmptyChange} />);

    onEmptyChange.mockClear();
    act(() => ref.current?.setText('some words'));
    expect(onEmptyChange).toHaveBeenCalledWith(false);

    onEmptyChange.mockClear();
    act(() => ref.current?.setText(''));
    expect(onEmptyChange).toHaveBeenCalledWith(true);
  });
});
