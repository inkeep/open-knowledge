import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

interface CreateArgs {
  docName: string;
  quote: string;
  body: string;
  prefix?: string;
  suffix?: string;
  onCreated?: (threadId: string) => void;
}

const DOC_TEXT = 'Toss the tofu with cornstarch.';
const QUOTE_FROM = DOC_TEXT.indexOf('the tofu');
const QUOTE_TO = QUOTE_FROM + 'the tofu'.length;

const captured = {
  created: [] as CreateArgs[],
  startComment: null as (() => void) | null,
  collapsedTo: [] as number[],
  panelTabs: [] as string[],
};

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

vi.doMock('./anchor-decorations', () => ({ setCommentDraftRange: () => {} }));

function fakeEditor() {
  return {
    isDestroyed: false,
    state: {
      selection: {
        from: QUOTE_FROM,
        to: QUOTE_TO,
        empty: false,
        ranges: [{ $from: { pos: QUOTE_FROM }, $to: { pos: QUOTE_TO } }],
      },
      doc: {
        nodesBetween: (from: number, to: number, fn: (node: unknown, pos: number) => void) => {
          fn(
            { isText: true, text: DOC_TEXT.slice(from, to), isBlock: false, isTextblock: false },
            from,
          );
        },
        content: { size: DOC_TEXT.length },
      },
    },
    commands: { setTextSelection: (pos: number) => captured.collapsedTo.push(pos) },
  };
}

afterEach(async () => {
  cleanup();
  captured.created.length = 0;
  captured.collapsedTo.length = 0;
  captured.panelTabs.length = 0;
  captured.startComment = null;
  const { setCommentsPanelOnScreen } = await import('./comments-panel-visibility');
  setCommentsPanelOnScreen(false);
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

    const [args] = captured.created;
    expect(args.docName).toBe('recipes/stir-fry');
    expect(args.quote).toBe('the tofu');
    expect(args.body).toBe('press it?');
    expect(args.prefix).toBe('Toss ');
    expect(args.suffix).toBe(' with cornstarch.');
    expect(args.onCreated).toBeUndefined();
  });

  test('Enter queues the comment', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(captured.created).toHaveLength(1);
    expect(captured.created[0].onCreated).toBeUndefined();
  });

  test('Cmd/Ctrl+Enter queues too — there is no send-now twin', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    expect(captured.created).toHaveLength(1);
    expect(captured.created[0].onCreated).toBeUndefined();
  });

  test('the card routes to the Comments tab instead of dispatching', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.click(screen.getByRole('button', { name: /view comments/i }));

    expect(captured.panelTabs).toEqual(['comments']);
    expect(captured.created).toEqual([]);
    expect(screen.queryByPlaceholderText('Add a comment')).not.toBeNull();
  });

  test('the route to the queue is withheld while the Comments tab is on screen', async () => {
    const { setCommentsPanelOnScreen } = await import('./comments-panel-visibility');
    setCommentsPanelOnScreen(true);
    await openComposer();

    expect(screen.queryByRole('button', { name: /view comments/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add comment/i })).not.toBeNull();
  });

  test('the route disappears when the tab opens under an open composer', async () => {
    const { setCommentsPanelOnScreen } = await import('./comments-panel-visibility');
    await openComposer();
    expect(screen.queryByRole('button', { name: /view comments/i })).not.toBeNull();

    await act(async () => {
      setCommentsPanelOnScreen(true);
    });

    expect(screen.queryByRole('button', { name: /view comments/i })).toBeNull();
  });

  test('posting collapses the selection — the passage has been filed', async () => {
    const field = await openComposer();
    fireEvent.change(field, { target: { value: 'press it?' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(captured.collapsedTo).toEqual([QUOTE_TO]);
  });

  test('cancelling leaves the selection alone', async () => {
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
    const popup = document.createElement('div');
    popup.dataset.suggestionPopup = 'composer-mention';
    document.body.append(popup);
    fireEvent.pointerDown(popup);

    expect(screen.queryByPlaceholderText('Add a comment')).not.toBeNull();
    popup.remove();
  });
});
