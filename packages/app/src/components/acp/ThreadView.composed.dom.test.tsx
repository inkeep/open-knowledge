import type {
  SessionUpdate,
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import fixture from '../../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null }),
}));
vi.doMock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

const { ThreadView } = await import('./ThreadView');
const { getAgentThreadClient } = await import('@/lib/acp/thread-client');

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

const CODEX = fixture.agents.codexRegistry;
const SOCKET_URL = 'ws://localhost:5173/collab/thread';

type AgentIdentity = typeof fixture.agents.codexRegistry;
const agentNamed = (name: string | undefined): AgentIdentity =>
  name === undefined ? CODEX : (fixture.agents as Record<string, AgentIdentity>)[name];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;

  readyState: number = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  openFromServer(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(frame: ThreadServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const realWebSocket = globalThis.WebSocket;
let socket: FakeSocket;
let threadId: string;
let threadCounter = 0;

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.last = null;
  act(() => {
    getAgentThreadClient().setUrl(SOCKET_URL);
  });
  if (FakeSocket.last === null) throw new Error('the client did not open a socket');
  socket = FakeSocket.last;
  act(() => {
    socket.openFromServer();
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    getAgentThreadClient().setUrl(null);
  });
  vi.stubGlobal('WebSocket', realWebSocket);
  vi.useRealTimers();
});

function openThread(overrides?: Omit<Partial<ThreadInfo>, 'threadId'>): ThreadInfo {
  threadCounter += 1;
  threadId = `composed-${threadCounter}`;
  const info: ThreadInfo = {
    agent: CODEX,
    title: 'Composed thread',
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: -1,
    archived: false,
    ...overrides,
    threadId,
  };
  act(() => {
    socket.deliver({ op: 'subscribed', threadId, fromSeq: 0, info });
  });
  return info;
}

function pushEvent(event: ThreadEvent, seq: number): void {
  act(() => {
    socket.deliver({ op: 'event', threadId, seq, event });
  });
}

function pushEvents(events: readonly ThreadEvent[], fromSeq: number): void {
  act(() => {
    socket.deliver({ op: 'events', threadId, fromSeq, events: [...events] });
  });
}

const asUpdate = (value: unknown): SessionUpdate => value as SessionUpdate;

let eventTs = 0;
function su(update: unknown): ThreadEvent {
  eventTs += 1;
  return { kind: 'session_update', update: asUpdate(structuredClone(update)), ts: eventTs };
}

function chunk(text: string, messageId?: string): ThreadEvent {
  return su({
    sessionUpdate: 'agent_message_chunk',
    ...(messageId === undefined ? {} : { messageId }),
    content: { type: 'text', text },
  });
}

const ROW_TESTIDS = [
  'agent-thread-agent-notice',
  'agent-thread-agent-message',
  'agent-thread-user-message',
  'agent-thread-thought',
  'agent-thread-notice',
  'agent-thread-tool-call',
] as const;

function transcriptRows(): [string, string][] {
  const transcript = screen.getByTestId('agent-thread-transcript');
  const selector = ROW_TESTIDS.map((id) => `[data-testid="${id}"]`).join(',');
  return [...transcript.querySelectorAll<HTMLElement>(selector)].map((row) => [
    row.dataset.testid ?? '',
    row.textContent ?? '',
  ]);
}

const noticeCards = (): HTMLElement[] => screen.queryAllByTestId('agent-thread-agent-notice');

describe('composed transcript: a Codex warning becomes a warning card', () => {
  test.each(
    fixture.candidates.map((candidate) => [candidate.name, candidate] as const),
  )('candidate %s arrives over the socket and draws one runtime-warning row', (_name, candidate) => {
    render(<ThreadView info={openThread()} />);

    pushEvent(su(candidate.update), 0);

    const cards = noticeCards();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card).toBe(screen.getByRole('note'));
    expect(card.textContent).toContain('Warning');
    expect(card.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const body = candidate.update.content.text.trim();
    expect(card.textContent).toContain(body.split('\n')[0]);
    expect(screen.queryByTestId('agent-thread-agent-message')).toBeNull();
  });

  test('a config warning keeps its detail paragraphs inside the one card', () => {
    const detailed = fixture.candidates.find((c) => c.name === 'config-warning-with-details');
    if (detailed === undefined) throw new Error('fixture lost its detailed config warning');
    render(<ThreadView info={openThread()} />);

    pushEvent(su(detailed.update), 0);

    expect(noticeCards()).toHaveLength(1);
    const card = noticeCards()[0];
    expect(card.textContent).toContain('Ignored 2 invalid entries in config.toml.');
    const bullets = within(card).getAllByRole('listitem');
    expect(bullets.map((bullet) => bullet.textContent)).toEqual([
      'model_reasoning_effort: expected one of low, medium, high',
      'sandbox_mode: unknown value full-access',
    ]);
  });

  test('a warning body renders producer markdown, so its links and fences are real controls', () => {
    render(<ThreadView info={openThread()} />);

    pushEvent(
      chunk('Warning: see https://example.com/docs for the fix.\n\n```toml\nmode = 1\n```\n\n'),
      0,
    );

    const card = noticeCards()[0];
    expect(card).toBe(screen.getByRole('note'));
    expect(within(card).getByRole('link').getAttribute('href')).toBe('https://example.com/docs');
    expect(within(card).getAllByRole('button').length).toBeGreaterThan(0);
  });

  test('a warning between adjacent no-ID chrome leaves both neighbours as prose', () => {
    render(<ThreadView info={openThread()} />);

    pushEvents(
      [
        su(fixture.neighbors.contextCompacted.update),
        su(fixture.candidates[0].update),
        su(fixture.neighbors.turnError.update),
      ],
      0,
    );

    expect(transcriptRows().map(([id]) => id)).toEqual([
      'agent-thread-agent-message',
      'agent-thread-agent-notice',
      'agent-thread-agent-message',
    ]);
    expect(screen.getByTestId('agent-thread-transcript').textContent).toContain(
      'stream disconnected before completion',
    );
  });
});

describe('composed transcript: near misses stay ordinary prose', () => {
  const SENTINEL = 'The refactor is safe.';

  test.each(
    fixture.negatives.map((negative) => [negative.name, negative] as const),
  )('near miss %s draws no warning card', (_name, negative) => {
    const agent = agentNamed((negative as { agent?: string }).agent);
    render(<ThreadView info={openThread({ agent })} />);

    pushEvents([su(negative.update), chunk(SENTINEL, 'sentinel')], 0);

    expect(noticeCards()).toHaveLength(0);
    expect(screen.queryAllByRole('note')).toHaveLength(0);
    const transcript = screen.getByTestId('agent-thread-transcript');
    expect(transcript.textContent).toContain(SENTINEL);
    const body = (negative.update as { content?: { type?: string; text?: string } }).content;
    if (body?.type === 'text' && body.text !== undefined && body.text.trim() !== '') {
      expect(transcript.textContent).toContain(body.text.trim());
    }
  });

  test('an ordinary answer carrying an item id stays a reply bubble', () => {
    render(<ThreadView info={openThread()} />);

    pushEvent(su(fixture.ordinaryAnswer.update), 0);

    expect(noticeCards()).toHaveLength(0);
    expect(screen.getByTestId('agent-thread-agent-message').textContent).toContain(
      'The skills are all still loaded.',
    );
  });

  test('a historical event that already merged chrome with a warning is one prose bubble', () => {
    const merged =
      fixture.neighbors.contextCompacted.update.content.text +
      fixture.candidates[0].update.content.text;
    render(<ThreadView info={openThread()} />);

    pushEvents([chunk(merged)], 0);

    expect(noticeCards()).toHaveLength(0);
    expect(transcriptRows().map(([id]) => id)).toEqual(['agent-thread-agent-message']);
    const bubble = screen.getByTestId('agent-thread-agent-message');
    expect(bubble.textContent).toContain("Context compacted to fit the model's context window.");
    expect(bubble.textContent).toContain('Warning: Skill descriptions were shortened');
  });
});

describe('composed transcript: delivery shape does not change what is drawn', () => {
  function sourceEvents(): ThreadEvent[] {
    return [
      { kind: 'user_message', content: 'check the skills', ts: 1 },
      su(fixture.neighbors.contextCompacted.update),
      su(fixture.candidates[0].update),
      chunk('Looking into it.', 'm1'),
      su(fixture.candidates[2].update),
      chunk('All set.', 'm2'),
    ];
  }

  function drawnWith(
    deliver: (events: ThreadEvent[]) => void,
    retainedThrough = -1,
  ): [string, string][] {
    render(<ThreadView info={openThread({ lastSeq: retainedThrough })} />);
    deliver(sourceEvents());
    const rows = transcriptRows();
    cleanup();
    return rows;
  }

  test('live, one-shot, batched, and replayed delivery draw the same transcript', () => {
    const live = drawnWith((events) => {
      events.forEach((event, index) => {
        pushEvent(event, index);
      });
    });
    const oneShot = drawnWith((events) => pushEvents(events, 0));
    const batched = drawnWith((events) => {
      pushEvents(events.slice(0, 2), 0);
      pushEvents(events.slice(2, 4), 2);
      pushEvents(events.slice(4), 4);
    });
    const replayed = drawnWith((events) => {
      pushEvents(events.slice(0, 3), 0);
      pushEvents(events.slice(3), 3);
    }, sourceEvents().length - 1);

    expect(live.map(([id]) => id)).toEqual([
      'agent-thread-user-message',
      'agent-thread-agent-message',
      'agent-thread-agent-notice',
      'agent-thread-agent-message',
      'agent-thread-agent-notice',
      'agent-thread-agent-message',
    ]);
    expect(oneShot).toEqual(live);
    expect(batched).toEqual(live);
    expect(replayed).toEqual(live);
  });

  test('a warning arriving live and the same event replayed from history agree', () => {
    const arrived = drawnWith((events) => pushEvent(events[2], 0));
    const fromHistory = drawnWith((events) => pushEvents([events[2]], 0), 0);

    expect(arrived.map(([id]) => id)).toEqual(['agent-thread-agent-notice']);
    expect(fromHistory).toEqual(arrived);
  });

  test('a replayed warning draws its card but announces nothing, unlike a live one', async () => {
    const announcer = () => screen.getByTestId('agent-thread-warning-announcer');

    render(<ThreadView info={openThread({ lastSeq: 0 })} />);
    pushEvents([sourceEvents()[2]], 0);
    expect(noticeCards()).toHaveLength(1);
    expect(announcer().textContent).toBe('');
    cleanup();

    render(<ThreadView info={openThread({ lastSeq: -1 })} />);
    pushEvent(sourceEvents()[2], 0);
    expect(noticeCards()).toHaveLength(1);
    await waitFor(() => expect(announcer().textContent).toContain('Codex reported:'));
  });
});

describe('composed transcript: existing rows keep their behaviour', () => {
  test('a startup failure still offers Retry, and the warning card carries none of it', async () => {
    render(<ThreadView info={openThread({ status: 'error' })} />);

    pushEvents(
      [
        su(fixture.candidates[0].update),
        {
          kind: 'status',
          status: 'error',
          ts: 2,
          failure: { reason: 'connect', agentMessage: 'initialize failed' },
        },
      ],
      0,
    );

    const failure = screen.getByTestId('agent-thread-notice');
    const retry = screen.getByTestId('agent-thread-retry');
    expect(failure.contains(retry)).toBe(true);
    expect(noticeCards()[0].contains(retry)).toBe(false);
    expect(within(noticeCards()[0]).queryAllByRole('button')).toHaveLength(0);

    await act(async () => {
      await userEvent.click(retry);
    });

    expect(socket.sent.map((frame) => JSON.parse(frame).op)).toContain('retry');
  });

  test('a failed prompt still offers Edit and resend, and it seeds the composer', async () => {
    render(<ThreadView info={openThread({ status: 'ready' })} />);

    pushEvents(
      [
        { kind: 'user_message', content: 'summarise the skills', ts: 1 },
        su(fixture.candidates[0].update),
        {
          kind: 'status',
          status: 'error',
          ts: 3,
          failure: { reason: 'prompt', agentMessage: 'the turn failed' },
        },
      ],
      0,
    );

    const restore = screen.getByTestId('agent-thread-restore');
    expect(restore.textContent).toContain('Edit and resend');

    await act(async () => {
      await userEvent.click(restore);
    });

    expect(screen.getByTestId<HTMLTextAreaElement>('agent-thread-composer').value).toBe(
      'summarise the skills',
    );
  });

  test('replies, thoughts, and tool calls draw as they always did alongside a warning', () => {
    render(<ThreadView info={openThread()} />);

    pushEvents(
      [
        { kind: 'user_message', content: 'run the tests', ts: 1 },
        su({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Checking the suite.' },
        }),
        su({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'completed',
        }),
        su(fixture.candidates[0].update),
        chunk('Everything passes.', 'm1'),
      ],
      0,
    );

    expect(transcriptRows().map(([id]) => id)).toEqual([
      'agent-thread-user-message',
      'agent-thread-thought',
      'agent-thread-tool-call',
      'agent-thread-agent-notice',
      'agent-thread-agent-message',
    ]);
    expect(screen.getByTestId('agent-thread-tool-call').textContent).toContain('Run tests');
    expect(screen.getByTestId('agent-thread-agent-message').textContent).toContain(
      'Everything passes.',
    );
  });

  test('a warning mid-turn does not end the turn', () => {
    render(<ThreadView info={openThread({ status: 'running' })} />);

    pushEvents(
      [
        { kind: 'user_message', content: 'check the skills', ts: 1 },
        { kind: 'turn_started', ts: 2 },
        su(fixture.candidates[0].update),
      ],
      0,
    );

    expect(noticeCards()).toHaveLength(1);
    expect(screen.getByTestId('agent-thread-working')).not.toBeNull();

    pushEvent({ kind: 'turn_ended', stopReason: 'end_turn', ts: 4 }, 3);

    expect(screen.queryByTestId('agent-thread-working')).toBeNull();
    expect(noticeCards()).toHaveLength(1);
  });
});
