/**
 * Guards the live-turn working row against a runaway render loop
 * ("Maximum update depth exceeded"). The row is the only part of the
 * transcript that updates on a timer rather than on an event, so a cascade
 * here would be invisible to every other ThreadView test.
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render as rtlRender } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RenderedItem, ThreadRenderModel } from '@/lib/acp/thread-event-model';
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

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
// The composer's rich input, doubled as a textarea — a real TipTap instance in
// jsdom schedules deferred scroll work that can crash the run after the suite
// passes, and this suite only needs the composer to mount.
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));
// The comments store is deliberately NOT mocked here. It is the one dependency
// in this component with a documented history of the runaway-update failure
// (an unstable `useSyncExternalStore` snapshot — see comments/store.ts), and
// every other ThreadView test stubs it out, so nothing else covers it.
vi.doMock('@/comments/queue-attachment', () => ({ prepareQueuedComments: async () => [] }));

const { ThreadView } = await import('./ThreadView');

function info(): ThreadInfo {
  return {
    threadId: 'thread-1',
    agent: { id: 'claude', name: 'Claude Agent', source: 'registry' },
    title: 'Test thread',
    status: 'running',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: 5,
    archived: false,
  };
}

const message: RenderedItem = {
  kind: 'message',
  role: 'agent',
  text: 'hello',
  messageId: 'm1',
};

afterEach(() => {
  cleanup();
  model = null;
});

describe('live-turn working row', () => {
  test('does not cascade as the idle line rotates', () => {
    // The rotation reschedules itself after every tick, so a cascade here would
    // blow React's nested-update limit and throw rather than settle. Several
    // minutes of turn are simulated to cover many rotations.
    vi.useFakeTimers();
    try {
      model = {
        items: [message],
        plan: [],
        turnActive: true,
        tokenUsage: null,
        terminals: {},
        permissionsByToolCall: {},
      };
      const { getByTestId } = render(<ThreadView info={info()} />);
      expect(getByTestId('agent-thread-working')).toBeTruthy();

      for (const ms of [11_000, 21_000, 61_000, 60_000, 120_000]) {
        act(() => {
          vi.advanceTimersByTime(ms);
        });
      }
      expect(getByTestId('agent-thread-working')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not cascade when the turn ends mid-rotation', () => {
    vi.useFakeTimers();
    try {
      model = {
        items: [message],
        plan: [],
        turnActive: true,
        tokenUsage: null,
        terminals: {},
        permissionsByToolCall: {},
      };
      const { rerender, queryByTestId } = render(<ThreadView info={info()} />);
      act(() => {
        vi.advanceTimersByTime(95_000);
      });

      model = { ...model, turnActive: false };
      rerender(<ThreadView info={info()} />);
      expect(queryByTestId('agent-thread-working')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
