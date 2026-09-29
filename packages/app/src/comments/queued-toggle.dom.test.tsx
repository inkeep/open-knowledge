import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    docName: 'recipes/stir-fry',
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body: 'press it?',
    createdAt: 1000,
    updatedAt: 1000,
    queued: true,
    ...overrides,
  };
}

function renderCard(t: CommentThread, sending = true) {
  return render(
    <TooltipProvider>
      <ThreadCard
        layout="doc"
        thread={t}
        cardRef={() => {}}
        focused={false}
        active={false}
        sending={sending}
      />
    </TooltipProvider>,
  );
}

afterEach(() => cleanup());

describe('the send tick', () => {
  test('names the action, not the state', () => {
    renderCard(thread());
    const tick = screen.getByRole('checkbox', { name: /don't send this comment/i });
    expect(tick.getAttribute('data-state')).toBe('checked');
  });

  test('follows the sending set, not the raw queued flag', () => {
    renderCard(thread({ queued: true }), false);
    const tick = screen.getByRole('checkbox', { name: /^send this comment$/i });
    expect(tick.getAttribute('data-state')).toBe('unchecked');
  });

  test('a resolved thread carries no tick', () => {
    renderCard(thread({ status: 'resolved' }), false);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: /reopen/i })).toBeTruthy();
  });
});

function openEdit(body: string) {
  renderCard(thread({ body }));
  fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
  return screen.getByRole('textbox', { name: /edit this comment/i });
}

function editorOf(box: HTMLElement): Editor {
  return (box as unknown as { editor: Editor }).editor;
}

describe('opening an edit', () => {
  test('puts the caret after the existing text, not in front of it', async () => {
    const box = openEdit('press it?');
    await waitFor(() => expect(document.activeElement).toBe(box));

    const editor = editorOf(box);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  });

  test('seeds the field with the comment as it stands', () => {
    const box = openEdit('these quantities disagree');
    expect(box.textContent).toContain('these quantities disagree');
  });

  test('the field REPLACES the comment rather than opening under it', () => {
    openEdit('these quantities disagree');
    expect(screen.queryByTestId('thread-comment-body')).toBeNull();
  });
});

describe('the active-thread tint', () => {
  test.each([
    ['doc', 'before:opacity-100'],
    ['project', 'bg-azure-800/5'],
  ] as const)('the active %s card carries its layout tint', (layout, tint) => {
    render(
      <TooltipProvider>
        <ThreadCard
          layout={layout}
          thread={thread()}
          cardRef={() => {}}
          focused={false}
          active={true}
          sending={false}
        />
      </TooltipProvider>,
    );
    const card = screen.getByRole('article');
    expect(card.className).toContain(tint);
  });

  test('the focused document card uses a rounded outline layer', () => {
    render(
      <TooltipProvider>
        <ThreadCard
          layout="doc"
          thread={thread()}
          cardRef={() => {}}
          focused={true}
          active={false}
          sending={false}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('article').className).toContain('before:ring-2');
  });

  test('the focused project card uses a visible ring', () => {
    render(
      <TooltipProvider>
        <ThreadCard
          layout="project"
          thread={thread()}
          cardRef={() => {}}
          focused={true}
          active={false}
          sending={false}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('article').className).toContain('ring-2 ring-primary');
  });

  test('the action controls reveal for visible keyboard focus without retaining pointer focus', () => {
    renderCard(thread());
    for (const action of ['Edit this comment', 'Delete this comment']) {
      const button = screen.getByRole('button', { name: action });
      expect(button.className).toContain('group-has-[:focus-visible]/comment-card:opacity-100');
      expect(button.className).toContain('[@media(hover:none)]:opacity-100');
      expect(button.className).toContain('[@media(hover:none)]:pointer-events-auto');
      expect(button.className).not.toContain('group-focus-within/comment-card');
    }
    cleanup();
    renderCard(thread({ status: 'resolved' }));
    const badge = screen.getByText('Resolved');
    const reopen = screen.getByRole('button', { name: 'Reopen' });
    expect(badge.className).toContain('group-has-[:focus-visible]/comment-card:opacity-0');
    expect(badge.className).toContain('[@media(hover:none)]:opacity-0');
    expect(reopen.className).toContain('group-has-[:focus-visible]/comment-card:opacity-100');
    expect(reopen.className).toContain('[@media(hover:none)]:opacity-100');
    expect(reopen.className).toContain('[@media(hover:none)]:pointer-events-auto');
    expect(badge.className).not.toContain('group-focus-within/comment-card');
    expect(reopen.className).not.toContain('group-focus-within/comment-card');
  });

  test('an inactive document card carries no tint', () => {
    renderCard(thread());
    expect(screen.getByRole('article').className).not.toContain('before:opacity-100');
  });
});

describe('a property thread in the panel', () => {
  test('shows its key as YAML instead of a quote, and offers no jump', () => {
    renderCard(thread({ target: { kind: 'property', key: 'tags', path: [] }, anchor: null }));
    expect(screen.getByText('tags:')).toBeTruthy();
    const target = screen.getByText('tags:').closest('button');
    expect(target?.hasAttribute('disabled')).toBe(true);
  });
});
