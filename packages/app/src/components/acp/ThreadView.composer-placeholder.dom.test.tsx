import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SUGGESTION_FADE_MS, SUGGESTION_HOLD_MS } from '@/hooks/use-rotating-suggestion';
import type { ThreadRenderModel } from '@/lib/acp/thread-event-model';
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

function placeholderText(): string {
  return (
    screen
      .getByTestId('agent-thread-composer-placeholder')
      .querySelector('[data-rotating-placeholder]')
      ?.getAttribute('data-rotating-placeholder') ?? ''
  );
}

function composerDescription(): string | null {
  const ids = screen.getByTestId('agent-thread-composer').getAttribute('aria-describedby');
  if (ids === null) return null;
  return ids
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`)
    .join(' ');
}

function advanceOnePhrase(): void {
  act(() => {
    vi.advanceTimersByTime(SUGGESTION_HOLD_MS);
  });
  act(() => {
    vi.advanceTimersByTime(SUGGESTION_FADE_MS);
  });
}

function collectPhrases(count: number): string[] {
  const seen = [placeholderText()];
  for (let i = 1; i < count; i++) {
    advanceOnePhrase();
    seen.push(placeholderText());
  }
  return seen;
}

afterEach(() => {
  cleanup();
  model = null;
  vi.useRealTimers();
});

describe('ACP composer placeholder', () => {
  test('opens on the plain message prompt once the agent is ready', () => {
    render(<ThreadView info={info()} />);

    expect(placeholderText()).toBe('Message Claude');
  });

  test('rotates through the mention hint and back around', () => {
    vi.useFakeTimers();
    render(<ThreadView info={info()} />);

    expect(collectPhrases(3)).toEqual([
      'Message Claude',
      "Type '@' to mention a page",
      'Message Claude',
    ]);
  });

  test('offers the slash hint only when the agent reports commands', () => {
    vi.useFakeTimers();
    render(
      <ThreadView
        info={info({ availableCommands: [{ name: 'review', description: 'Review the diff' }] })}
      />,
    );

    expect(collectPhrases(4)).toEqual([
      'Message Claude',
      "Type '@' to mention a page",
      "Type '/' for commands",
      'Message Claude',
    ]);
  });

  test('offers Commands in the shared add menu only when the agent reports commands', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThreadView info={info()} />);

    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));
    expect(screen.queryByRole('menuitem', { name: 'Commands' })).toBeNull();
    await user.keyboard('{Escape}');

    rerender(
      <ThreadView
        info={info({ availableCommands: [{ name: 'review', description: 'Review the diff' }] })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));

    expect(screen.getByRole('menuitem', { name: 'Commands' })).toBeDefined();
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('textbox', { name: 'Message Claude' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'Add to prompt' }));

    expect(screen.queryByRole('menuitem', { name: 'Commands' })).toBeNull();
  });

  test('holds the sign-in prompt instead of rotating while auth is pending', () => {
    vi.useFakeTimers();
    render(<ThreadView info={info({ status: 'auth_required' })} />);

    expect(placeholderText()).toBe('Sign in to Claude first');

    advanceOnePhrase();

    expect(placeholderText()).toBe('Sign in to Claude first');
  });

  test('holds the resume prompt on an archived thread', () => {
    vi.useFakeTimers();
    render(<ThreadView info={info({ archived: true })} />);

    expect(placeholderText()).toBe('Pick up where you left off');

    advanceOnePhrase();

    expect(placeholderText()).toBe('Pick up where you left off');
  });

  test('holds a plain prompt while the agent is still starting', () => {
    vi.useFakeTimers();
    render(<ThreadView info={info({ status: 'spawning' })} />);

    expect(placeholderText()).toBe('Message Claude');

    advanceOnePhrase();

    expect(placeholderText()).toBe('Message Claude');
  });

  test('describes both triggers to assistive tech when the agent reports commands', () => {
    render(
      <ThreadView
        info={info({ availableCommands: [{ name: 'review', description: 'Review the diff' }] })}
      />,
    );

    expect(composerDescription()).toBe("Type '@' to mention a page and Type '/' for commands");
  });

  test('describes only the mention trigger when the agent reports no commands', () => {
    render(<ThreadView info={info()} />);

    expect(composerDescription()).toBe("Type '@' to mention a page");
  });

  test('drops the description and its hint text while the composer is not accepting prompts', () => {
    render(<ThreadView info={info({ status: 'auth_required' })} />);

    expect(composerDescription()).toBeNull();
    expect(screen.queryByText("Type '@' to mention a page")).toBeNull();
  });
});
