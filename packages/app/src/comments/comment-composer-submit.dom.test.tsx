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
 * "Send to AI" hands over rather than queueing.
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

const captured = {
  created: [] as CreateArgs[],
  startComment: null as (() => void) | null,
  collapsedTo: [] as number[],
  sent: [] as { threadIds?: readonly string[]; submit?: boolean; resolve?: boolean }[],
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

vi.doMock('./append-to-open-session', () => ({
  appendQueueToOpenSession: (args: Record<string, unknown>) => {
    captured.sent.push(args);
    return Promise.resolve(1);
  },
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
        from: 4,
        to: 12,
        empty: false,
        // The composer takes its span from `ranges`, not `from`/`to` — those
        // report the first range only, which on a table CellSelection is one
        // cell. A real Selection always carries `ranges`, so the double does
        // too; a single range is the TextSelection case this file covers.
        ranges: [{ $from: { pos: 4 }, $to: { pos: 12 } }],
      },
      // `content.size` bounds the selection-context capture — a real PM node
      // always carries it, so the double has to as well.
      doc: { textBetween: () => 'the tofu', content: { size: 40 } },
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
  captured.sent.length = 0;
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
    // occurrence was picked when the quoted words appear more than once. The
    // double returns the same string for every range, so both sides read alike.
    const [args] = captured.created;
    expect(args.docName).toBe('recipes/stir-fry');
    expect(args.quote).toBe('the tofu');
    expect(args.body).toBe('press it?');
    expect(args.prefix).toBe('the tofu');
    expect(args.suffix).toBe('the tofu');
    // No `onCreated` — filing it is the whole action, so nothing is handed on.
    expect(args.onCreated).toBeUndefined();
  });

  test('Enter files it too, so the keyboard never reaches the irreversible one', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(captured.created).toHaveLength(1);
    expect(captured.created[0].onCreated).toBeUndefined();
  });

  test('Send to AI hands the comment over and resolves it', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.click(screen.getByRole('button', { name: /send to ai/i }));

    const [args] = captured.created;
    expect(args.body).toBe('press it?');
    // The send is sequenced behind creation because only the store has the id.
    expect(args.onCreated).toBeDefined();

    args.onCreated?.('t1');
    // `resolve` is what keeps it out of the queue: a sent comment is not a
    // review item waiting to go, and leaving it open would send it twice.
    expect(captured.sent).toEqual([{ threadIds: ['t1'], submit: true, resolve: true }]);
  });

  test('posting collapses the selection — the passage has been filed', async () => {
    // The composer PINS a selection so it survives clicking away into the
    // input. Filing a comment is the one case where that is wrong: the passage
    // now rides the batch as that comment's quote, so leaving it selected sends
    // the same words to the agent twice.
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(captured.collapsedTo).toEqual([12]); // the end of the picked range
  });

  test('cancelling leaves the selection alone', async () => {
    // Escape is not "done with this passage" — you may still want it.
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(captured.collapsedTo).toEqual([]);
  });

  test('an empty draft files nothing, from either button', async () => {
    await openComposer();
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));
    fireEvent.click(screen.getByRole('button', { name: /send to ai/i }));

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
