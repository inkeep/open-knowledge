/**
 * tests for the composer's `@`-mention input.
 *
 * Two groups:
 *   - Serialization: a directly-constructed TipTap editor (the same extension
 *     set the component mounts) exercises `serializeComposerContent` +
 *     `isComposerEmpty` — chips serialize inline as `@path`, mentions are
 *     ordered + de-duplicated.
 *   - Component: the rendered input exposes a `textbox`, routes Enter -> onSubmit
 *     (but not Shift+Enter), and — load-bearing — does NOT register itself in the
 *     active-editor registry, so `getEditorForDoc` keeps returning the real
 *     document editor (which selection-as-passage reads from).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Content, JSONContent } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import { createRef } from 'react';
import { fileEntryPathIconToSvgString } from '@/components/file-entry-icon';
import { getEditorForDoc, registerEditor, unregisterEditor } from './active-editor';
import { ComposerMentionInput, type ComposerMentionInputHandle } from './ComposerMentionInput';
import {
  composerMentionExtensions,
  composerMentionSuggestionKey,
  isComposerEmpty,
  serializeComposerContent,
} from './composer-mention/composer-mention';

function makeEditor(content?: Content) {
  return new Editor({ extensions: composerMentionExtensions(), content });
}

function paragraph(...inline: Content[]) {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] } as Content;
}

function mentionNode(path: string, label = path): Content {
  return { type: 'composerMention', attrs: { path, label } };
}

let consoleErrorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // The editor's async mount emits act() warnings under jsdom; real failures
  // still surface as missing-element assertion failures.
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
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
      expect(serializeComposerContent(editor)).toEqual({ instruction: '', mentions: [] });
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

  test('plain prose carries no mentions', () => {
    const editor = makeEditor(paragraph({ type: 'text', text: 'just words' }));
    try {
      expect(serializeComposerContent(editor)).toEqual({ instruction: 'just words', mentions: [] });
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
    const onSubmit = mock(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(0);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('setText replaces the field with plain text (read back via getContent)', () => {
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Describe"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    ref.current?.setText('a research wiki');
    expect(ref.current?.getContent()).toEqual({ instruction: 'a research wiki', mentions: [] });
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
    // The mention renders via its node view: a compact chip (`.composer-mention-chip`,
    // styled single-line + ellipsis + max-width in globals.css so a long label never
    // wraps) whose LEADING icon doubles as an aria-labeled remove control that
    // deletes the node from the prompt — the inline counterpart of the top-row
    // chip's leading-icon remove button.
    const removeBtn = screen.getByRole('button', { name: /Remove Notes/i });
    expect(removeBtn).toBeTruthy();
    const chip = removeBtn.closest('.composer-mention-chip');
    expect(chip).not.toBeNull();
    // The chip surfaces its full name/path on hover (the label ellipsizes).
    expect(chip?.getAttribute('title')).toBe('Notes');
    // The label carries the truncation hook so a long mention ellipsizes.
    expect(chip?.querySelector('.composer-mention-label')?.textContent).toBe('Notes');
    // The remove control IS the LEADING icon cell (Cursor pattern): the
    // `.composer-mention-icon` button — NOT a trailing ×. It holds two stacked
    // glyphs (the file/type icon at rest, × on reveal) that cross-fade via
    // opacity ONLY (the transition lives in CSS), so the cell never changes size
    // and the chip box never reflows. There is NO trailing `.composer-mention-remove`
    // slot.
    expect(removeBtn.classList.contains('composer-mention-icon')).toBe(true);
    expect(removeBtn.matches('.composer-mention-chip > .composer-mention-icon:first-child')).toBe(
      true,
    );
    expect(chip?.querySelector('.composer-mention-remove')).toBeNull();
    // Both glyphs are inline SVGs (not the literal `@`/`×` text). The resting
    // glyph is the same file-entry icon used by search/sidebar rows, and the
    // hover glyph is the lucide X. Assert each cell holds an <svg>, not text.
    const restIcon = removeBtn.querySelector('.composer-mention-glyph-icon');
    const hoverIcon = removeBtn.querySelector('.composer-mention-glyph-x');
    expect(restIcon?.querySelector('svg')).not.toBeNull();
    expect(hoverIcon?.querySelector('svg')).not.toBeNull();
    expect(restIcon?.textContent).not.toContain('@');
    expect(hoverIcon?.textContent).not.toContain('×');
    // The resting <svg> is the custom markdown file glyph for a `.md` mention,
    // inheriting the chip color via currentColor.
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
    // The leading cell injects the same file-entry glyph the picker + top-row
    // chip resolve for this path. Normalize both sides through the DOM: jsdom
    // re-serializes the injected `<path .../>` as `<path ...></path>`, so compare
    // parsed-element outerHTML, not raw strings.
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

    // The two folder vs page glyphs are genuinely different (type-awareness, not
    // a constant icon).
    expect(folderSvg).not.toBe(pageSvg);
  });

  test('mounting does NOT register in the active-editor registry', () => {
    // Seed a real document editor for some doc; the composer must not displace
    // it (getEditorForDoc keeps returning the document editor — the registry the
    // selection-passage feature reads from).
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

/**
 * Enter must defer to an open `@`-mention popup: while the suggestion plugin is
 * active, plain Enter commits the highlighted item (the plugin's own onKeyDown
 * owns that) and must NOT submit the prompt; with the popup closed, Enter
 * submits. This is a ProseMirror prop-precedence path — the component's
 * `editorProps.handleKeyDown` and the suggestion plugin's `props.handleKeyDown`
 * are both registered keydown handlers, and the fix makes the component's
 * handler yield (`return false`) when the popup is open.
 *
 * The component's editor is reached via the textbox DOM node, which TipTap
 * tags with the live `editor` instance — inserting `@foo` flips the suggestion
 * plugin's `active` state synchronously (it matches the `@`-trigger against the
 * doc text, independent of the async page fetch resolving), so the precedence
 * can be exercised with a real keydown.
 *
 * A Playwright case is still recommended to cover the full popup→arrow→Enter
 * keystroke flow (including the chip actually inserting); this jsdom test pins
 * the load-bearing branch: submit-vs-defer keyed on plugin `active` state.
 */
describe('ComposerMentionInput — Enter defers to the @-mention popup', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // The suggestion's async `items` step calls `fetch('/api/pages')`; jsdom has
    // no backend, so stub it to an empty corpus. The plugin's `active` state
    // does not depend on the fetch resolving — it is computed synchronously from
    // the inserted `@`-trigger — so the empty corpus does not affect the assertion.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ pages: [], documents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function getComposerEditor(box: HTMLElement): Editor {
    // TipTap's EditorContent tags the contenteditable host node with the live
    // editor instance; the textbox role resolves to that same node.
    return (box as unknown as { editor: Editor }).editor;
  }

  function isSuggestionActive(editor: Editor): boolean {
    const state = composerMentionSuggestionKey.getState(editor.state) as
      | { active: boolean }
      | undefined;
    return state?.active ?? false;
  }

  test('Enter submits while the popup is closed', () => {
    const onSubmit = mock(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    expect(isSuggestionActive(editor)).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('Enter does NOT submit while the @-popup is open (defers to the suggestion plugin)', () => {
    const onSubmit = mock(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    // Typing `@foo` opens the mention popup (plugin `active` flips synchronously).
    editor.commands.insertContent('@foo');
    expect(isSuggestionActive(editor)).toBe(true);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  test('Enter resumes submitting once the popup closes', () => {
    const onSubmit = mock(() => {});
    render(
      <ComposerMentionInput ariaLabel="Ask AI" onEmptyChange={() => {}} onSubmit={onSubmit} />,
    );
    const box = screen.getByRole('textbox', { name: 'Ask AI' });
    const editor = getComposerEditor(box);

    editor.commands.insertContent('@foo');
    expect(isSuggestionActive(editor)).toBe(true);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(0);

    // Clearing the field tears the trigger down; Enter submits again.
    editor.commands.clearContent(true);
    expect(isSuggestionActive(editor)).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
