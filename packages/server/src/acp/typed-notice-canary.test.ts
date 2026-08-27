import {
  client as acpClient,
  methods as acpMethods,
  ndJsonStream,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * ACP's typed `notice` update is the eventual home for agent warnings, but no
 * released SDK carries it. These characterize what the INSTALLED SDK does with
 * one today, so an upgrade that starts accepting notices cannot slip past as a
 * silent behavior change. The connection is built exactly as the thread
 * manager builds it — `acpClient(...)` over `ndJsonStream` — because the
 * rejection happens in the SDK's own static session-update router, upstream of
 * any handler this codebase registers.
 *
 * The agent side is a pair of in-memory web streams: no child process, no
 * socket, no registry fetch.
 */

/** JSON-RPC 2.0 "Invalid params". */
const INVALID_PARAMS = -32602;

const SESSION_ID = 'canary-session';

type Peer = {
  /** Deliver one raw JSON-RPC message from the agent side. */
  send: (message: unknown) => void;
  /** Close the agent's output stream, as a departing agent would. */
  endAgentOutput: () => void;
  /** Every `session/update` that survived the SDK's router. */
  delivered: SessionNotification[];
  connectionState: () => 'open' | 'settled';
  dispose: () => Promise<void>;
};

/**
 * A refused notification produces no JSON-RPC response — a notification has no
 * id to answer — so the SDK's log line is the only signal that it ran the
 * message and declined it. Collecting the error payloads makes "the SDK has
 * finished refusing N messages" a condition tests can wait on instead of a
 * duration they have to guess.
 */
let refusals: Record<string, unknown>[] = [];

beforeEach(() => {
  refusals = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null && 'code' in arg) {
        refusals.push(arg as Record<string, unknown>);
      }
    }
  });
});

function connectToFakeAgent(): Peer {
  const encoder = new TextEncoder();
  let enqueue!: (line: string) => void;
  let endAgentOutput!: () => void;
  const agentToClient = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (line) => controller.enqueue(encoder.encode(`${line}\n`));
      endAgentOutput = () => controller.close();
    },
  });
  const clientToAgent = new WritableStream<Uint8Array>({ write() {} });

  const delivered: SessionNotification[] = [];
  const conn = acpClient({ name: 'open-knowledge-typed-notice-canary' })
    .onNotification(acpMethods.client.session.update, (ctx) => {
      delivered.push(ctx.params);
    })
    .connect(ndJsonStream(clientToAgent, agentToClient));

  let state: 'open' | 'settled' = 'open';
  const settle = () => {
    state = 'settled';
  };
  conn.closed.then(settle, settle);

  return {
    send: (message) => enqueue(JSON.stringify(message)),
    endAgentOutput,
    delivered,
    connectionState: () => state,
    dispose: async () => {
      if (state === 'open') endAgentOutput();
      await conn.closed.catch(() => {});
    },
  };
}

/**
 * A `notice` session update carrying the required severity + title of ACP's
 * unstable Session Notices schema. Whether the installed SDK knows the
 * discriminator at all is settled by the core session-update roster check;
 * this payload is here to characterize what the runtime validator does when
 * one arrives.
 */
function typedNoticeNotification(): unknown {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'notice',
        severity: 'warning',
        title: 'skill bundle exceeded its budget',
      },
    },
  };
}

function agentTextNotification(text: string): unknown {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  };
}

const deliveredText = (peer: Peer): string[] =>
  peer.delivered.map((n) => (n.update as { content?: { text?: string } }).content?.text ?? '');

async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let peers: Peer[] = [];
function openPeer(): Peer {
  const peer = connectToFakeAgent();
  peers.push(peer);
  return peer;
}

afterEach(async () => {
  const open = peers;
  peers = [];
  for (const peer of open) await peer.dispose();
  vi.restoreAllMocks();
});

describe('installed ACP SDK versus a typed session notice', () => {
  test('delivers a supported update through this transport', async () => {
    const peer = openPeer();

    peer.send(agentTextNotification('ordinary answer'));
    await until(() => peer.delivered.length > 0, 'the supported update to arrive');

    expect(deliveredText(peer)).toEqual(['ordinary answer']);
  });

  test('drops a typed notice before it reaches a session-update handler', async () => {
    const peer = openPeer();

    // The supported update behind it is the positive control: an empty
    // delivery list would otherwise read the same as a broken transport.
    peer.send(typedNoticeNotification());
    peer.send(agentTextNotification('ordinary answer'));
    await until(
      () => refusals.length > 0 && peer.delivered.length > 0,
      'the notice to be refused and the supported update to arrive',
    );

    expect(peer.delivered.map((n) => n.update.sessionUpdate)).toEqual(['agent_message_chunk']);
  });

  test('refuses the typed notice as invalid params rather than ignoring it', async () => {
    const peer = openPeer();

    peer.send(typedNoticeNotification());
    await until(() => refusals.length > 0, 'the notice to be refused');

    expect(refusals.map((r) => r.code)).toEqual([INVALID_PARAMS]);
  });

  test('keeps the connection open and still delivers later supported updates', async () => {
    const peer = openPeer();

    peer.send(typedNoticeNotification());
    peer.send(agentTextNotification('answer after the notice'));
    peer.send(agentTextNotification('and the one after that'));
    await until(() => peer.delivered.length >= 2, 'both later updates to arrive');

    expect(peer.connectionState()).toBe('open');
    expect(deliveredText(peer)).toEqual(['answer after the notice', 'and the one after that']);
  });

  test('survives a run of typed notices without degrading', async () => {
    const peer = openPeer();
    const run = 5;

    for (let i = 0; i < run; i++) peer.send(typedNoticeNotification());
    peer.send(agentTextNotification('still answering'));
    await until(
      () => refusals.length >= run && peer.delivered.length > 0,
      'every notice to be refused and the supported update to arrive',
    );

    expect(peer.connectionState()).toBe('open');
    expect(deliveredText(peer)).toEqual(['still answering']);
    expect(refusals).toHaveLength(run);
  });

  // Without this, every `connectionState() === 'open'` assertion above would
  // hold just as well for a probe that can never report anything else.
  test('settles the connection once the agent stops writing', async () => {
    const peer = openPeer();
    expect(peer.connectionState()).toBe('open');

    peer.endAgentOutput();
    await until(() => peer.connectionState() === 'settled', 'the connection to settle');

    expect(peer.connectionState()).toBe('settled');
  });
});
