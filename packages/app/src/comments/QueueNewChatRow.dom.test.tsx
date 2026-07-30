/**
 * The queue send's one override row.
 *
 * The send is automatic — a live chat takes the batch, none open starts one —
 * so this row exists solely for the case the automatic answer gets wrong: a
 * chat is open, but this batch belongs in a clean one. Without it, having any
 * chat open would make a fresh turn unreachable.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { QueueNewChatRow } from './QueueNewChatRow';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

afterEach(() => cleanup());

/** Mounted in an open menu — it is a menu item and needs the menu's context. */
function renderRow(onStartNewChat = () => {}) {
  return render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <QueueNewChatRow onStartNewChat={onStartNewChat} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe('the new-chat override row', () => {
  test('names the act, matching the verb the dock uses', async () => {
    // "Start" is what the dock's own primary says ("Start an agent") and what
    // the send button says with no chat open — one verb for one act.
    renderRow();
    const row = await screen.findByTestId('comment-queue-send-new');
    expect(row.textContent).toContain('Start a new chat');
  });

  test('starts a fresh turn', async () => {
    const user = userEvent.setup();
    let started = 0;
    renderRow(() => {
      started += 1;
    });

    await user.click(await screen.findByTestId('comment-queue-send-new'));
    expect(started).toBe(1);
  });
});
