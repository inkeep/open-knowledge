import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

let openThreads: ThreadInfo[] = [];

vi.doMock('@/lib/acp/thread-client', () => ({
  useOpenAgentThreadTabs: () => openThreads,
}));

const { TerminalRevealTab } = await import('./TerminalRevealTab');

const LABEL = { bottom: 'Open terminal', right: 'Open agents panel' } as const;

function makeThread(overrides: Partial<ThreadInfo> & { threadId: string }): ThreadInfo {
  return {
    agent: { id: 'a', name: 'Agent', source: 'registry' },
    title: overrides.threadId,
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 1,
    lastSeq: 0,
    archived: false,
    ...overrides,
  };
}

function renderTab(edge: 'bottom' | 'right') {
  const onReveal = vi.fn(() => {});
  render(
    <TooltipProvider>
      <TerminalRevealTab edge={edge} onReveal={onReveal} />
    </TooltipProvider>,
  );
  return { onReveal };
}

describe('TerminalRevealTab', () => {
  afterEach(() => {
    cleanup();
    openThreads = [];
  });

  test('names the panel it reopens and fires onReveal on click', async () => {
    const user = userEvent.setup();
    const { onReveal } = renderTab('right');

    await user.click(screen.getByRole('button', { name: LABEL.right }));

    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test('labels each edge for its own panel, so the two are never confusable', () => {
    renderTab('right');
    expect(screen.getByRole('button', { name: LABEL.right })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LABEL.bottom })).toBeNull();
    cleanup();

    renderTab('bottom');
    expect(screen.getByRole('button', { name: LABEL.bottom })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LABEL.right })).toBeNull();
  });

  test('marks which edge it hugs so it sits where the collapse control was', () => {
    renderTab('right');
    expect(
      screen.getByRole('button', { name: LABEL.right }).getAttribute('data-terminal-reveal'),
    ).toBe('right');
    cleanup();

    renderTab('bottom');
    expect(
      screen.getByRole('button', { name: LABEL.bottom }).getAttribute('data-terminal-reveal'),
    ).toBe('bottom');
  });

  test('surfaces its label in a tooltip on hover', async () => {
    const user = userEvent.setup();
    renderTab('bottom');

    await user.hover(screen.getByRole('button', { name: LABEL.bottom }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain(LABEL.bottom);
  });

  test('a live thread surfaces a presence dot on the agents edge while the panel is closed', () => {
    openThreads = [
      makeThread({ threadId: 't1', title: 'Working' }),
      makeThread({ threadId: 't2', title: 'Also working', createdAt: 2, lastActivityAt: 2 }),
      makeThread({ threadId: 't3', title: 'Third', createdAt: 3, lastActivityAt: 3 }),
    ];

    renderTab('right');

    expect(screen.getByTestId('agents-reveal-live-dot')).toBeTruthy();
    expect(screen.getByTestId('agents-reveal-live-dot').getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Open agents panel — 3 live agent threads' }),
    ).toBeTruthy();
  });

  test('one live thread names the panel with the singular live count', () => {
    openThreads = [makeThread({ threadId: 't1', title: 'Working' })];

    renderTab('right');

    expect(
      screen.getByRole('button', { name: 'Open agents panel — 1 live agent thread' }),
    ).toBeTruthy();
  });

  test('no presence dot without live threads, on the terminal edge, or for archived-only threads', () => {
    renderTab('right');
    expect(screen.queryByTestId('agents-reveal-live-dot')).toBeNull();
    cleanup();

    openThreads = [makeThread({ threadId: 't1', title: 'Working' })];
    renderTab('bottom');
    expect(screen.queryByTestId('agents-reveal-live-dot')).toBeNull();
    cleanup();

    openThreads = [makeThread({ threadId: 't1', title: 'History', archived: true })];
    renderTab('right');
    expect(screen.queryByTestId('agents-reveal-live-dot')).toBeNull();
  });
});
