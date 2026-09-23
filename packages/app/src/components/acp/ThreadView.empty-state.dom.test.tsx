import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ThreadRenderModel } from '@/lib/acp/thread-event-model';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

function ReadyRowCommitRecorder({ commits }: { commits: (string | null)[] }) {
  useLayoutEffect(() => {
    const row = document.querySelector('[data-testid="agent-thread-ready"]');
    commits.push(row?.getAttribute('class') ?? null);
  });
  return null;
}

function markOf(testId: string): Element {
  const mark = screen.getByTestId(testId).firstElementChild;
  expect(mark?.tagName.toLowerCase()).toBe('svg');
  if (mark === null) throw new Error(`no mark inside ${testId}`);
  return mark;
}

function signedOutModel(): ThreadRenderModel {
  return {
    items: [
      {
        kind: 'notice',
        text: '',
        tone: 'error',
        failure: { reason: 'auth-required', agentMessage: 'sign in required' },
        attempts: 1,
      },
    ],
    plan: [],
    turnActive: false,
    tokenUsage: null,
    terminals: {},
    permissionsByToolCall: {},
  };
}

function endSettleAnimation(element: HTMLElement): void {
  act(() => {
    for (const name of ['animationend', 'webkitAnimationEnd']) {
      element.dispatchEvent(new Event(name, { bubbles: true }));
    }
  });
}

let model: ThreadRenderModel | null = null;

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({
    respondPermission: () => {},
    respondRuntimeConsent: () => {},
    cancel: () => {},
    prompt: () => {},
    editQueued: () => {},
    removeQueued: () => {},
    setMode: () => {},
    setConfigOption: () => {},
    closeThread: () => {},
    createThread: async () => {
      throw new Error('unused');
    },
    resumeThread: async () => {
      throw new Error('unused');
    },
  }),
  ThreadChannelUnavailableError: class ThreadChannelUnavailableError extends Error {},
  ThreadResumeError: class ThreadResumeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  useAgentThread: () => ({ info: undefined, events: [], lastSeq: 5 }),
  useAgentThreadModel: () => model,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null }),
}));
vi.doMock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));
vi.doMock('@/components/acp/AgentMarkdown', () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));
vi.doMock('@/comments/queue-attachment', () => ({ prepareQueuedComments: async () => [] }));

const { ThreadView } = await import('./ThreadView');

function info(overrides?: Partial<ThreadInfo>): ThreadInfo {
  return {
    threadId: 'thread-1',
    agent: { id: 'claude', name: 'Claude Agent', source: 'registry' },
    title: 'Test thread',
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: 5,
    archived: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  model = null;
});

describe('ACP thread empty state', () => {
  test('invites the user in once the agent is ready', () => {
    render(<ThreadView info={info()} />);

    expect(screen.getByTestId('agent-thread-ready').textContent).toBe('What should we work on?');
  });

  test('skips the settle when an already-ready thread is re-opened', () => {
    render(<ThreadView info={info()} />);

    expect(screen.getByTestId('agent-thread-ready').className).not.toContain(
      'animate-agent-ready-settle',
    );
  });

  test('settles when the ready row first mounts after the sign-in card', () => {
    model = signedOutModel();
    const view = render(<ThreadView info={info({ status: 'auth_required' })} />);

    expect(screen.queryByTestId('agent-thread-ready')).toBeNull();

    model = null;
    view.rerender(<ThreadView info={info({ status: 'ready' })} />);

    expect(screen.getByTestId('agent-thread-ready').className).toContain(
      'animate-agent-ready-settle',
    );
  });

  test('carries the settle on the commit that first shows the ready row', () => {
    const commits: (string | null)[] = [];
    const view = render(
      <>
        <ThreadView info={info({ status: 'spawning' })} />
        <ReadyRowCommitRecorder commits={commits} />
      </>,
    );

    expect(commits.at(-1)).toBeNull();

    view.rerender(
      <>
        <ThreadView info={info({ status: 'ready' })} />
        <ReadyRowCommitRecorder commits={commits} />
      </>,
    );

    const firstCommitShowingTheRow = commits.find((entry) => entry !== null);
    expect(firstCommitShowingTheRow).toContain('animate-agent-ready-settle');
  });

  test('applies the settle when the agent finishes starting', () => {
    const view = render(<ThreadView info={info({ status: 'spawning' })} />);

    expect(screen.queryByTestId('agent-thread-ready')).toBeNull();

    view.rerender(<ThreadView info={info({ status: 'ready' })} />);

    expect(screen.getByTestId('agent-thread-ready').className).toContain(
      'animate-agent-ready-settle',
    );
  });

  test('drops the settle class once it has played, so re-showing cannot replay it', async () => {
    const view = render(<ThreadView info={info({ status: 'spawning' })} />);
    view.rerender(<ThreadView info={info({ status: 'ready' })} />);

    const row = await screen.findByTestId('agent-thread-ready');
    expect(row.className).toContain('animate-agent-ready-settle');

    endSettleAnimation(row);

    await waitFor(() => {
      expect(screen.getByTestId('agent-thread-ready').className).not.toContain(
        'animate-agent-ready-settle',
      );
    });
  });

  test('keeps the settle pending while the row has not painted, so a hidden tab still plays it', async () => {
    vi.useFakeTimers();
    try {
      const view = render(<ThreadView info={info({ status: 'spawning' })} />);
      view.rerender(<ThreadView info={info({ status: 'ready' })} />);

      const row = screen.getByTestId('agent-thread-ready');

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(row.className).toContain('animate-agent-ready-settle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('shows the mark in colour while the thread waits on sign-in', () => {
    render(<ThreadView info={info({ status: 'auth_required' })} />);

    expect(screen.getByTestId('agent-thread-auth-action')).not.toBeNull();
    expectVisualClassTokensAbsent(markOf('agent-thread-auth-offer').getAttribute('class') ?? '', [
      'opacity-25',
      'grayscale',
    ]);
  });

  test('keeps the mark grey on a thread that is not usable', () => {
    render(<ThreadView info={info({ status: 'error' })} />);

    expect(screen.getByTestId('agent-thread-auth-action')).not.toBeNull();
    expectVisualClassTokens(markOf('agent-thread-auth-offer').getAttribute('class') ?? '', [
      'opacity-25',
      'grayscale',
    ]);
  });

  test('shows the agent mark beside the invitation, at full colour rather than the disabled grey', () => {
    render(<ThreadView info={info()} />);

    const mark = screen.getByTestId('agent-thread-ready').querySelector('svg');
    expect(mark).not.toBeNull();
    const markClass = mark?.getAttribute('class') ?? '';
    expectVisualClassTokens(markClass, ['size-6']);
    expectVisualClassTokensAbsent(markClass, ['opacity-25', 'grayscale', 'size-12']);
  });

  test('keeps the starting mark grey, which the colour rule calls the not-usable state', () => {
    render(<ThreadView info={info({ status: 'spawning' })} />);

    expectVisualClassTokens(
      markOf('agent-thread-starting-empty-state').getAttribute('class') ?? '',
      ['opacity-25', 'grayscale'],
    );
  });

  test('keeps the starting treatment while the agent spawns', () => {
    render(<ThreadView info={info({ status: 'spawning' })} />);

    expect(screen.queryByTestId('agent-thread-ready')).toBeNull();
    expect(screen.getByTestId('agent-thread-transcript').textContent).toContain('Starting Claude');
  });

  test('does not show the invitation on an archived thread', () => {
    render(<ThreadView info={info({ archived: true })} />);

    expect(screen.queryByTestId('agent-thread-ready')).toBeNull();
  });
});
