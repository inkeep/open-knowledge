import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';

const sent: (readonly string[])[] = [];
let openSession: { kind: 'thread'; agentId: string; iconUrl: string | null } | null = null;

vi.doMock('@/components/acp/RegisteredAgentIcon', () => ({
  RegisteredAgentIcon: () => null,
}));
vi.doMock('@/components/handoff/AgentSplitButton', () => ({
  AgentSplitButton: ({
    primary,
    onPrimary,
    primaryDisabled,
    testIds,
  }: {
    primary: ReactNode;
    onPrimary: () => void;
    primaryDisabled: boolean;
    testIds: { primary: string };
  }) => (
    <Button
      type="button"
      data-testid={testIds.primary}
      disabled={primaryDisabled}
      onClick={onPrimary}
    >
      {primary}
    </Button>
  ),
}));
vi.doMock('@/components/reusable-session-store', () => ({ useReusableSession: () => openSession }));
vi.doMock('@/lib/keyboard-shortcuts', () => ({
  formatShortcut: () => '⇧⌘ Enter',
  formatShortcutLabel: () => 'Shift Command Enter',
}));
vi.doMock('./use-comment-agent-picker', () => ({
  useCommentAgentPicker: () => ({ threadAgent: null, rows: {} }),
}));
vi.doMock('./use-comment-delivery', () => ({ useCommentDispatch: () => () => {} }));
vi.doMock('./use-send-queue', () => ({
  useSendQueue: () => (ids: readonly string[]) => sent.push(ids),
}));

afterEach(() => {
  cleanup();
  sent.length = 0;
  openSession = null;
});

test('footer names an open chat in the button and shortcut tooltip', async () => {
  openSession = { kind: 'thread', agentId: 'agent', iconUrl: null };
  const { CommentSendFooter } = await import('./CommentSendFooter');
  render(
    <CommentSendFooter
      threadIds={['a']}
      totalCount={1}
      selection={<span>Bulk selection</span>}
      testIdPrefix="comments"
    />,
  );

  expect(screen.getByRole('button', { name: 'Send to chat' })).toBeTruthy();
  expect(screen.getByText('⇧⌘ ↵').getAttribute('title')).toBe('Send to chat (Shift Command Enter)');
});

test('footer shows the selection and Enter glyph, and sends the selected threads', async () => {
  const { CommentSendFooter } = await import('./CommentSendFooter');
  render(
    <CommentSendFooter
      threadIds={['a', 'b']}
      totalCount={4}
      selection={<span>Bulk selection</span>}
      testIdPrefix="comments"
    />,
  );

  expect(screen.getByText('Bulk selection')).toBeTruthy();
  expect(screen.getByText('2 of 4')).toBeTruthy();
  expect(screen.getByText('⇧⌘ ↵')).toBeTruthy();
  expect(screen.getByText('⇧⌘ ↵').getAttribute('title')).toBe(
    'Start a new chat (Shift Command Enter)',
  );
  expect(screen.getByRole('button', { name: 'Start a new chat' })).toBeTruthy();
  fireEvent.click(screen.getByTestId('comments-send'));
  expect(sent).toEqual([['a', 'b']]);
});
