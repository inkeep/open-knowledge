/**
 * What the comment composer does with a finished draft.
 *
 * The FIELD is `ComposerMentionInput` and is doubled here: Enter-submits,
 * Shift+Enter-newline, and the IME-composition guard are its behaviour and are
 * covered by its own tests. Re-driving them through this host would test the
 * same handler twice and break whenever the field's internals move.
 *
 * What is left is what this component owns: which payload gets filed, that a
 * filed passage stops being selected while a cancelled one does not, and that
 * filing is the only thing the card does — the batch goes out from the Comments
 * tab, which this card only routes to.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

// `vi.doMock`, not `vi.mock`: doMock is NOT hoisted, so the factory can close
// over these declarations and over the top-level lingui import. The component
// is pulled in with a dynamic import below, after the mocks are registered.
interface CreateArgs {
  docName: string;
  quote: string;
  body: string;
  prefix?: string;
  suffix?: string;
  onCreated?: (threadId: string) => void;
}

/**
 * The document the editor double models. Real text with real offsets, so the
 * captured prefix and suffix are the ones this document would actually yield.
 */
const DOC_TEXT = 'Toss the tofu with cornstarch.';
const QUOTE_FROM = DOC_TEXT.indexOf('the tofu');
const QUOTE_TO = QUOTE_FROM + 'the tofu'.length;

const captured = {
  created: [] as CreateArgs[],
  startComment: null as (() => void) | null,
  collapsedTo: [] as number[],
  panelTabs: [] as string[],
};

/** The field, doubled as a plain textarea that honours the same handle. */
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: ({
    ref,
    placeholder,
    onEmptyChange,
    onSubmit,
    onEscape,
  }: {
    ref?: { current: unknown };
    placeholder?: string;
    onEmptyChange: (empty: boolean) => void;
    onSubmit: () => void;
    onEscape?: () => void;
  }) => {
    // Reads through to the live element rather than a captured local: the host
    // re-renders on every emptiness change, which would reset a closure variable
    // and leave `getContent` returning the draft as it was one keystroke ago.
    return (
      <textarea
        placeholder={placeholder}
        ref={(el) => {
          if (ref === undefined || ref === null || el === null) return;
          ref.current = {
            focus: () => {},
            blur: () => {},
            clear: () => {
              el.value = '';
            },
            setText: () => {},
            getContent: () => ({ instruction: el.value, mentions: [] }),
          };
        }}
        onChange={(e) => {
          onEmptyChange(e.target.value.trim().length === 0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) onSubmit();
          if (e.key === 'Escape') onEscape?.();
        }}
      />
    );
  },
}));

vi.doMock('@/components/doc-panel-events', () => ({
  requestDocPanelTab: (tab: string) => captured.panelTabs.push(tab),
}));

vi.doMock('./store', () => ({
  createThread: (args: CreateArgs) => captured.created.push(args),
  subscribeStartComment: (cb: () => void) => {
    captured.startComment = cb;
    return () => {
      captured.startComment = null;
    };
  },
}));

// The draft highlight writes through ProseMirror; not what's under test here.
vi.doMock('./anchor-decorations', () => ({ setCommentDraftRange: () => {} }));

/** The slice of the editor the composer actually touches. */
function fakeEditor() {
  return {
    isDestroyed: false,
    state: {
      selection: {
        from: QUOTE_FROM,
        to: QUOTE_TO,
        empty: false,
        // The composer takes its span from `ranges`, not `from`/`to` — those
        // report the first range only, which on a table CellSelection is one
        // cell. A real Selection always carries `ranges`, so the double does
        // too; a single range is the TextSelection case this file covers.
        ranges: [{ $from: { pos: QUOTE_FROM }, $to: { pos: QUOTE_TO } }],
      },
      // `content.size` bounds the selection-context capture — a real PM node
      // always carries it, so the double has to as well.
      doc: {
        // Both the quote and its surrounding context come from
        // `commentQuoteText`, which walks the doc rather than calling
        // `textBetween` — that is what lets an inline atom (a wiki link, a tag)
        // contribute the text it keeps in attributes. So the double yields
        // nodes, and yields the slice actually asked for: a window-insensitive
        // double would let the context assertions below pass on a prefix and
        // suffix no document could have produced.
        nodesBetween: (from: number, to: number, fn: (node: unknown, pos: number) => void) => {
          fn(
            { isText: true, text: DOC_TEXT.slice(from, to), isBlock: false, isTextblock: false },
            from,
          );
        },
        content: { size: DOC_TEXT.length },
      },
    },
    // Records the collapse so the test can assert the passage stops being
    // "selected for whatever you do next" once it has been filed.
    commands: { setTextSelection: (pos: number) => captured.collapsedTo.push(pos) },
  };
}

afterEach(() => {
  cleanup();
  captured.created.length = 0;
  captured.collapsedTo.length = 0;
  captured.panelTabs.length = 0;
  captured.startComment = null;
});

async function openComposer() {
  const { CommentSelectionAffordance } = await import('./CommentSelectionAffordance');
  // biome-ignore lint/suspicious/noExplicitAny: structural editor double
  render(<CommentSelectionAffordance editor={fakeEditor() as any} docName="recipes/stir-fry" />);
  captured.startComment?.();
  return screen.findByPlaceholderText('Add a comment');
}

describe('the comment composer', () => {
  test('Add Comment files the passage with the context that disambiguates it', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    // The surrounding text rides along: it is what tells the server which
    // occurrence was picked when the quoted words appear more than once — so
    // these are the exact words either side of the pick in the document above.
    const [args] = captured.created;
    expect(args.docName).toBe('recipes/stir-fry');
    expect(args.quote).toBe('the tofu');
    expect(args.body).toBe('press it?');
    expect(args.prefix).toBe('Toss ');
    expect(args.suffix).toBe(' with cornstarch.');
    // No `onCreated` — filing it is the whole action, so nothing is handed on.
    expect(args.onCreated).toBeUndefined();
  });

  test('Enter queues the comment', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(captured.created).toHaveLength(1);
    // No `onCreated` is what makes this a queue-only filing: a hand-off would be
    // sequenced behind creation, so its absence means nothing shipped.
    expect(captured.created[0].onCreated).toBeUndefined();
  });

  // The modifier used to reach a second, irreversible action. With that action
  // gone, ⌘Enter must land on the one that is left rather than on nothing.
  test('Cmd/Ctrl+Enter queues too — there is no send-now twin', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    expect(captured.created).toHaveLength(1);
    // No `onCreated` is what makes this queue-only: a hand-off would be
    // sequenced behind creation, so its absence means nothing shipped.
    expect(captured.created[0].onCreated).toBeUndefined();
  });

  test('the card routes to the Comments tab instead of dispatching', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.click(screen.getByRole('button', { name: /open comments/i }));

    expect(captured.panelTabs).toEqual(['comments']);
    // Leaving is not filing: the draft survives the trip so nothing is lost.
    expect(captured.created).toEqual([]);
    expect(screen.queryByPlaceholderText('Add a comment')).not.toBeNull();
  });

  test('posting collapses the selection — the passage has been filed', async () => {
    // The composer PINS a selection so it survives clicking away into the
    // input. Filing a comment is the one case where that is wrong: the passage
    // now rides the batch as that comment's quote, so leaving it selected sends
    // the same words to the agent twice.
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(captured.collapsedTo).toEqual([QUOTE_TO]); // the end of the picked range
  });

  test('cancelling leaves the selection alone', async () => {
    // Escape is not "done with this passage" — you may still want it.
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(captured.collapsedTo).toEqual([]);
  });

  test('an empty draft files nothing', async () => {
    await openComposer();
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    expect(captured.created).toEqual([]);
  });

  test('Escape closes without posting', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(captured.created).toEqual([]);
    expect(screen.queryByPlaceholderText('Add a comment')).toBeNull();
  });

  test('a click outside closes it', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.pointerDown(document.body);

    expect(captured.created).toEqual([]);
    expect(screen.queryByPlaceholderText('Add a comment')).toBeNull();
  });

  test('a click on the mention results does NOT close it', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: '@' } });
    // The `@`-results are portaled to `document.body`, so they are outside the
    // card by DOM but not by intent — picking a file must not read as a click
    // away.
    const popup = document.createElement('div');
    popup.dataset.suggestionPopup = 'composer-mention';
    document.body.append(popup);
    fireEvent.pointerDown(popup);

    expect(screen.queryByPlaceholderText('Add a comment')).not.toBeNull();
    popup.remove();
  });
});
