import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionUpdate, ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { AgentSessionManager } from '@inkeep/open-knowledge-server';
import {
  AcpPermissionStore,
  AcpRegistry,
  AcpThreadManager,
  attachAcpThreadSocket,
  getLogger,
} from '@inkeep/open-knowledge-server';
import { act, cleanup, render as rtlRender, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
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
const { getAgentThreadClient, useAgentThread } = await import('@/lib/acp/thread-client');

const log = getLogger('acp-crash-recovery-test');
const AGENT_ID = 'codex-acp';
const AGENT_NAME = 'Codex';
const SOCKET_URL = 'ws://localhost:5173/collab/thread';
const REPLAY_CHUNK = 512;

const HISTORIC_WARNING_A = fixture.candidates[0].update.content.text;
const HISTORIC_WARNING_B = fixture.candidates[2].update.content.text;
const LIVE_WARNING = fixture.candidates[1].update.content.text;

const su = (update: unknown, ts: number): ThreadEvent => ({
  kind: 'session_update',
  update: update as SessionUpdate,
  ts,
});

const agentChunk = (text: string, ts: number): ThreadEvent =>
  su({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, ts);

const thoughtChunk = (ts: number): ThreadEvent =>
  su({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '.' } }, ts);

function crashedTranscript(): ThreadEvent[] {
  const events: ThreadEvent[] = [{ kind: 'user_message', content: 'check the skills', ts: 1 }];
  events.push(agentChunk(HISTORIC_WARNING_A, 2));
  while (events.length < REPLAY_CHUNK) events.push(thoughtChunk(events.length + 1));
  events.push(agentChunk(HISTORIC_WARNING_B, events.length + 1));
  return events;
}

const CRASHED_EVENTS = crashedTranscript();
const DURABLE_LAST_SEQ = CRASHED_EVENTS.length - 1;
const STALE_LAST_SEQ = 1;

function writeCrashedThread(localDir: string, threadId: string): void {
  const threadsDir = join(localDir, 'threads');
  mkdirSync(threadsDir, { recursive: true });
  writeFileSync(
    join(threadsDir, `${threadId}.ndjson`),
    `${CRASHED_EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  writeFileSync(
    join(threadsDir, `${threadId}.meta.json`),
    JSON.stringify({
      version: 1,
      info: {
        threadId,
        agent: { id: AGENT_ID, name: AGENT_NAME, source: 'registry' },
        title: 'Crashed thread',
        status: 'running',
        createdAt: 1,
        lastActivityAt: 2,
        modes: null,
        configOptions: null,
        lastSeq: STALE_LAST_SEQ,
      },
      sessionId: 'sess-fixed',
      cwd: localDir,
      agentRef: { source: 'registry', id: AGENT_ID },
    }),
  );
}

function writeResumableRegistryAgent(binDir: string, warningText: string): void {
  const agentPath = join(binDir, 'agent.mjs');
  writeFileSync(
    agentPath,
    `
const write = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const WARNING = ${JSON.stringify(warningText)};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      });
    } else if (msg.method === 'session/resume') {
      reply({});
    } else if (msg.method === 'session/prompt') {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-fixed',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: WARNING },
          },
        },
      });
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(join(binDir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${agentPath}"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(binDir, 'node'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${process.versions.node}; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
}

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('fixture agents never use client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

function makeManager(contentDir: string, localDir: string, binDir: string): AcpThreadManager {
  const manifest = {
    id: AGENT_ID,
    name: AGENT_NAME,
    version: '1.6.2',
    distribution: { npx: { package: `@fake/${AGENT_ID}`, env: { PATH: binDir } } },
  };
  return new AcpThreadManager({
    contentDir,
    localDir,
    globalDir: null,
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ agents: [manifest] }), {
          status: 200,
        })) as unknown as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager: fakeSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    log,
    resolveLoginShellPath: async () => null,
  });
}

let manager: AcpThreadManager | null = null;
let replayFrameSizes: number[] = [];

class BridgedSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = BridgedSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private readonly serverListeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly url: string) {
    if (manager === null) throw new Error('no thread manager bound to the socket');
    attachAcpThreadSocket(
      {
        send: (data: string) => {
          const frame = JSON.parse(data) as { op: string; events?: unknown[] };
          if (frame.op === 'events') replayFrameSizes.push(frame.events?.length ?? 0);
          this.onmessage?.({ data });
        },
        close: () => this.close(),
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const list = this.serverListeners.get(event) ?? [];
          list.push(listener);
          this.serverListeners.set(event, list);
        },
      },
      manager,
      log,
    );
    this.readyState = BridgedSocket.OPEN;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    for (const listener of this.serverListeners.get('message') ?? []) listener(data);
  }

  close(): void {
    if (this.readyState === BridgedSocket.CLOSED) return;
    this.readyState = BridgedSocket.CLOSED;
    for (const listener of this.serverListeners.get('close') ?? []) listener();
    this.onclose?.();
  }
}

const realWebSocket = globalThis.WebSocket;
let dirs: string[] = [];
let threadCounter = 0;

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-crash-recovery-'));
  dirs.push(dir);
  return dir;
}

async function until(predicate: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const render = (ui: ReactNode) => rtlRender(ui, { wrapper: TooltipProvider });

function ThreadHost({ threadId }: { threadId: string }): ReactNode {
  const state = useAgentThread(threadId);
  return state === null ? null : <ThreadView info={state.info} />;
}

const client = () => getAgentThreadClient();
const noticeCards = (): HTMLElement[] => screen.queryAllByTestId('agent-thread-agent-notice');
const announcer = (): HTMLElement => screen.getByTestId('agent-thread-warning-announcer');
const noticeCount = (threadId: string): number =>
  (client().getThreadModel(threadId)?.items ?? []).filter((item) => item.kind === 'agent_notice')
    .length;

function recordAnnouncements(region: HTMLElement): () => string[] {
  const spoken: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const text = node.textContent ?? '';
        if (text !== '') spoken.push(text);
      }
    }
  });
  observer.observe(region, { childList: true });
  return () => {
    observer.takeRecords().forEach((record) => {
      for (const node of record.addedNodes) {
        const text = node.textContent ?? '';
        if (text !== '') spoken.push(text);
      }
    });
    return [...spoken];
  };
}

async function openCrashedThread(): Promise<{ threadId: string; spoken: () => string[] }> {
  threadCounter += 1;
  const threadId = `crashed-${threadCounter}`;
  const localDir = tmp();
  const binDir = tmp();
  writeCrashedThread(localDir, threadId);
  writeResumableRegistryAgent(binDir, LIVE_WARNING);
  manager = makeManager(tmp(), localDir, binDir);
  await manager.init();

  await act(async () => {
    client().setUrl(SOCKET_URL);
    await until(() => client().getThread(threadId) !== null, 'the thread roster');
  });
  render(<ThreadHost threadId={threadId} />);
  return { threadId, spoken: recordAnnouncements(announcer()) };
}

beforeEach(() => {
  replayFrameSizes = [];
  vi.stubGlobal('WebSocket', BridgedSocket);
});

afterEach(async () => {
  cleanup();
  act(() => {
    client().setUrl(null);
  });
  vi.stubGlobal('WebSocket', realWebSocket);
  await manager?.destroy();
  manager = null;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe.skipIf(process.platform === 'win32')('crash-recovered transcript', () => {
  test('replays every historical warning across several frames without announcing any', async () => {
    const { threadId, spoken } = await openCrashedThread();

    await act(async () => {
      client().openArchivedThread(threadId);
      await until(
        () => (client().getThread(threadId)?.lastSeq ?? -1) === DURABLE_LAST_SEQ,
        'the durable log to finish replaying',
      );
    });

    expect(replayFrameSizes.length).toBeGreaterThan(1);
    expect(replayFrameSizes.reduce((a, b) => a + b, 0)).toBe(CRASHED_EVENTS.length);

    const cards = noticeCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain(HISTORIC_WARNING_A.trim().split('\n')[0]);
    expect(cards[1].textContent).toContain(HISTORIC_WARNING_B.trim().split('\n')[0]);
    expect(announcer().textContent).toBe('');
    expect(spoken()).toEqual([]);
  }, 30_000);

  test('speaks the first warning that arrives after that replay, once', async () => {
    const { threadId, spoken } = await openCrashedThread();
    const composer = () => screen.getByTestId('agent-thread-composer');

    await act(async () => {
      client().openArchivedThread(threadId);
      await until(
        () => (client().getThread(threadId)?.lastSeq ?? -1) === DURABLE_LAST_SEQ,
        'the durable log to finish replaying',
      );
    });
    composer().focus();
    const focused = document.activeElement;

    await act(async () => {
      await client().resumeThread(threadId, 'go');
      await until(() => noticeCount(threadId) === 3, 'the resumed agent to warn');
    });

    expect(noticeCards()).toHaveLength(3);
    await act(async () => {
      await until(() => spoken().length > 0, 'the live warning to be announced');
    });
    expect(spoken()).toEqual([`${AGENT_NAME} reported: ${LIVE_WARNING.trim().split('\n')[0]}`]);
    expect(document.activeElement).toBe(focused);
  }, 30_000);
});
