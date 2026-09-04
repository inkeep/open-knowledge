import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThreadMeta } from './comments-client';

let serverBody = 'first draft';

function meta(): CommentThreadMeta {
  return {
    threadId: 't1',
    docName: 'notes/rollout',
    target: { kind: 'body' },
    anchor: { exact: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    state: 'anchored',
    queued: true,
    latestComment: serverBody,
    createdBy: 'principal-abc',
    createdAt: 1000,
  };
}

vi.doMock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

vi.doMock('./comments-client', () => ({
  listThreads: vi.fn(async () => [meta()]),
  editComment: vi.fn(async (_threadId: string, body: string) => {
    serverBody = body;
    return meta();
  }),
  createThread: vi.fn(),
  reply: vi.fn(),
  reopenThread: vi.fn(),
  replaceAnchor: vi.fn(),
  queueThread: vi.fn(),
  unqueueThread: vi.fn(),
  deleteThread: vi.fn(),
  prepareDispatchBatch: vi.fn(),
  completeDispatchBatch: vi.fn(),
}));

const store = await import('./store');
const { ThreadCard } = await import('./ThreadCard');

function Surfaces() {
  const threads = store.useCommentThreads('notes/rollout');
  const thread = threads[0];
  if (!thread) return null;
  return (
    <TooltipProvider>
      <div data-testid="doc-side">
        <ThreadCard
          thread={thread}
          cardRef={() => {}}
          focused={false}
          active={false}
          sending={false}
        />
      </div>
      <div data-testid="project-side">
        <ThreadCard
          thread={thread}
          cardRef={() => {}}
          focused={false}
          active={false}
          sending={false}
        />
      </div>
    </TooltipProvider>
  );
}

afterEach(() => cleanup());

describe('editing a comment', () => {
  test("saving in one card updates the other card's text", async () => {
    render(<Surfaces />);
    await waitFor(() => expect(screen.getAllByText('first draft')).toHaveLength(2));

    const docSide = screen.getByTestId('doc-side');
    fireEvent.click(
      // biome-ignore lint/style/noNonNullAssertion: the card renders its edit button or the earlier waitFor failed
      docSide.querySelector('button[aria-label="Edit this comment"]')!,
    );
    const field = await screen.findByRole('textbox', { name: /edit this comment/i });
    const editor = (
      field as unknown as { editor: { commands: { setContent: (t: string) => void } } }
    ).editor;
    editor.commands.setContent('second thoughts');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => {
      const projectSide = screen.getByTestId('project-side');
      expect(projectSide.textContent).toContain('second thoughts');
    });
    expect(screen.getByTestId('doc-side').textContent).toContain('second thoughts');
    expect(screen.queryByText('first draft')).toBeNull();
  });
});
