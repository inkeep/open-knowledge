import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createCollaborationHost } from './collaboration-host.ts';
import { buildIngressPolicy } from './ingress-policy.ts';

function createLog() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as never;
}

function createSocket() {
  const value = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  value.destroy = vi.fn(() => value.emit('close'));
  return value;
}

function request(url: string, host = 'localhost', origin?: string) {
  return {
    url,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    socket: { remoteAddress: '127.0.0.1' },
  } as never;
}

function createHocuspocus() {
  return {
    handleConnection: vi.fn(() => ({ handleMessage: vi.fn(), handleClose: vi.fn() })),
    getConnectionsCount: vi.fn(() => 0),
  } as never;
}

function callbackUpgrade(host: ReturnType<typeof createCollaborationHost>, ws: EventEmitter): void {
  vi.spyOn(host.wss, 'handleUpgrade').mockImplementation((_req, _socket, _head, callback) => {
    callback(ws as never);
    return host.wss;
  });
}

async function withTimeout<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

describe('createCollaborationHost', () => {
  test('leaves non-collaboration upgrades completely untouched', () => {
    const log = createLog();
    const host = createCollaborationHost({ hocuspocus: createHocuspocus(), log });
    const raw = createSocket();

    expect(host.handleUpgrade(request('/vite-hmr'), raw as never, Buffer.alloc(0))).toBe(false);
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(raw.listenerCount('error')).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  test('routes thread then keepalive before bare collaboration', () => {
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({ hocuspocus, log, acpThreadManager: null });
    const thread = createSocket();
    expect(host.handleUpgrade(request('/collab/thread'), thread as never, Buffer.alloc(0))).toBe(
      true,
    );
    expect(thread.destroy).toHaveBeenCalledOnce();

    const keepaliveWs = new EventEmitter();
    callbackUpgrade(host, keepaliveWs);
    const keepalive = createSocket();
    expect(
      host.handleUpgrade(request('/collab/keepalive'), keepalive as never, Buffer.alloc(0)),
    ).toBe(true);

    const bareWs = new EventEmitter();
    callbackUpgrade(host, bareWs);
    const bare = createSocket();
    expect(host.handleUpgrade(request('/collab'), bare as never, Buffer.alloc(0))).toBe(true);
    expect(hocuspocus.handleConnection).toHaveBeenCalledOnce();
  });

  test('routes an admitted thread socket without forwarding it to Hocuspocus', () => {
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      acpThreadManager: {} as never,
    });
    const threadWs = new EventEmitter() as EventEmitter & {
      close: () => void;
      send: () => void;
    };
    threadWs.close = () => {};
    threadWs.send = () => {};
    callbackUpgrade(host, threadWs);

    expect(
      host.handleUpgrade(request('/collab/thread'), createSocket() as never, Buffer.alloc(0)),
    ).toBe(true);
    expect(threadWs.listenerCount('message')).toBe(1);
    expect(hocuspocus.handleConnection).not.toHaveBeenCalled();
  });

  test('refuses local bad Host and foreign thread Origin', () => {
    const log = createLog();
    const host = createCollaborationHost({
      hocuspocus: createHocuspocus(),
      log,
      acpThreadManager: {} as never,
    });
    const badThread = createSocket();
    const badKeepalive = createSocket();
    const foreignOrigin = createSocket();

    host.handleUpgrade(
      request('/collab/thread', 'evil.example'),
      badThread as never,
      Buffer.alloc(0),
    );
    host.handleUpgrade(
      request('/collab/keepalive', 'evil.example'),
      badKeepalive as never,
      Buffer.alloc(0),
    );
    host.handleUpgrade(
      request('/collab/thread', 'localhost', 'https://evil.example'),
      foreignOrigin as never,
      Buffer.alloc(0),
    );
    expect(badThread.destroy).toHaveBeenCalledOnce();
    expect(badKeepalive.destroy).toHaveBeenCalledOnce();
    expect(foreignOrigin.destroy).toHaveBeenCalledOnce();
  });

  test('refuses forwarded bare collaboration upgrades when remote access is disabled', () => {
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({ hocuspocus, log });
    const raw = createSocket();
    const forwardedRequest = request('/collab') as {
      headers: Record<string, string>;
    };
    forwardedRequest.headers['x-forwarded-for'] = '203.0.113.7';

    expect(host.handleUpgrade(forwardedRequest as never, raw as never, Buffer.alloc(0))).toBe(true);
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(hocuspocus.handleConnection).not.toHaveBeenCalled();
    // The tripwire hint names the consent surface (OK_ALLOW_EXTERNAL +
    // OK_EXTERNAL_URL, or the server.* config equivalents).
    expect(log.warn).toHaveBeenCalledWith(
      { url: '/collab', host: 'localhost' },
      '[remote] refused proxied WS upgrade; consent with OK_ALLOW_EXTERNAL=1 + OK_EXTERNAL_URL (or server.allowExternal + server.externalUrl in config)',
    );
  });

  test('uses the tunnel-shape admission (externalUrl + consent) for bare collaboration upgrades', () => {
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      // A tunneled exposure shape: declared public origin + consent on a
      // loopback bind.
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1'],
          externalUrl: 'https://myproject.ngrok.app',
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: true,
        },
      }),
    });
    const admittedWs = new EventEmitter();
    callbackUpgrade(host, admittedWs);
    const admitted = createSocket();
    const refused = createSocket();

    expect(
      host.handleUpgrade(
        request('/collab', 'myproject.ngrok.app'),
        admitted as never,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(
      host.handleUpgrade(request('/collab', 'evil.example'), refused as never, Buffer.alloc(0)),
    ).toBe(true);
    expect(hocuspocus.handleConnection).toHaveBeenCalledOnce();
    expect(admitted.destroy).not.toHaveBeenCalled();
    expect(refused.destroy).toHaveBeenCalledOnce();
  });

  test('under allowExternal consent, plain /collab validates Host (foreign refused, admitted names pass)', () => {
    // Before, plain /collab was gated only under the old remote-access flow, so
    // consented exposure (allowExternal) left it ungated and any Host reached
    // full CRDT read/write. It now runs the consolidated admit gate — loopback
    // + bind literals + externalUrl — under consent too.
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1', '100.64.0.7'],
          externalUrl: undefined,
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: false,
        },
      }),
    });

    // Foreign Host (DNS-rebinding shape) is refused even under consent.
    const foreign = createSocket();
    expect(
      host.handleUpgrade(request('/collab', 'evil.example'), foreign as never, Buffer.alloc(0)),
    ).toBe(true);
    expect(foreign.destroy).toHaveBeenCalledOnce();
    expect(hocuspocus.handleConnection).not.toHaveBeenCalled();

    // The bind-address literal is an admitted Host (direct-IP access).
    const bindLiteralWs = new EventEmitter();
    callbackUpgrade(host, bindLiteralWs);
    const bindLiteral = createSocket();
    expect(
      host.handleUpgrade(
        request('/collab', '100.64.0.7:55222'),
        bindLiteral as never,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(bindLiteral.destroy).not.toHaveBeenCalled();

    // Loopback still works alongside the exposure.
    const loopbackWs = new EventEmitter();
    callbackUpgrade(host, loopbackWs);
    const loopback = createSocket();
    expect(
      host.handleUpgrade(request('/collab', 'localhost'), loopback as never, Buffer.alloc(0)),
    ).toBe(true);
    expect(loopback.destroy).not.toHaveBeenCalled();
    expect(hocuspocus.handleConnection).toHaveBeenCalledTimes(2);
  });

  test('under allowExternal consent, plain /collab refuses a foreign Origin (CSWSH defense)', () => {
    // CWE-1275: WS upgrades bypass CORS, so a page on a foreign origin can open
    // wss://<externalUrl>/collab — the Host passes (externalUrl) and, under consent,
    // so does the relaxed peer gate. A present-but-foreign Origin is the only
    // signal separating that cross-site hijack from a first-party client, so it
    // MUST be refused here exactly as /collab/thread refuses it. A missing
    // Origin (native / server-to-server client) is admitted.
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1', '100.64.0.7'],
          externalUrl: 'https://kb.example.com',
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: false,
        },
      }),
    });

    // Attack: the externalUrl Host is admitted, but the foreign Origin is not.
    const attacker = createSocket();
    expect(
      host.handleUpgrade(
        request('/collab', 'kb.example.com', 'https://evil.example'),
        attacker as never,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(attacker.destroy).toHaveBeenCalledOnce();
    expect(hocuspocus.handleConnection).not.toHaveBeenCalled();

    // A first-party page on the externalUrl origin is admitted.
    const firstPartyWs = new EventEmitter();
    callbackUpgrade(host, firstPartyWs);
    const sameOrigin = createSocket();
    expect(
      host.handleUpgrade(
        request('/collab', 'kb.example.com', 'https://kb.example.com'),
        sameOrigin as never,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(sameOrigin.destroy).not.toHaveBeenCalled();

    // A native / server-to-server client carrying no Origin is admitted.
    const nativeWs = new EventEmitter();
    callbackUpgrade(host, nativeWs);
    const noOrigin = createSocket();
    expect(
      host.handleUpgrade(request('/collab', 'kb.example.com'), noOrigin as never, Buffer.alloc(0)),
    ).toBe(true);
    expect(noOrigin.destroy).not.toHaveBeenCalled();
    expect(hocuspocus.handleConnection).toHaveBeenCalledTimes(2);
  });

  test('a PURE-LOCAL /collab (no consent) still refuses a foreign Origin (localhost CSWSH)', () => {
    // Localhost is reachable from any origin and WS bypasses CORS, so a foreign
    // page can open ws://127.0.0.1:<port>/collab against a loopback-only server
    // (peer + Host both loopback). The Origin check is UNCONDITIONAL — it fires
    // even with no consent — so this cross-site hijack is refused. The peer+Host
    // admit gate stays exposure-only (pure-local keeps its historical posture on
    // that axis); only the Origin/CSWSH axis is always on.
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      ingressPolicy: buildIngressPolicy({}),
    });

    const attacker = createSocket();
    expect(
      host.handleUpgrade(
        request('/collab', 'localhost', 'https://evil.example'),
        attacker as never,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(attacker.destroy).toHaveBeenCalledOnce();
    expect(hocuspocus.handleConnection).not.toHaveBeenCalled();

    // The first-party app (a loopback Origin) is admitted.
    const appWs = new EventEmitter();
    callbackUpgrade(host, appWs);
    const app = createSocket();
    expect(
      host.handleUpgrade(
        request('/collab', 'localhost', 'http://localhost:5173'),
        app as never,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(app.destroy).not.toHaveBeenCalled();

    // A no-Origin client stays admitted on a pure-local server.
    const nativeWs = new EventEmitter();
    callbackUpgrade(host, nativeWs);
    const native = createSocket();
    expect(
      host.handleUpgrade(request('/collab', 'localhost'), native as never, Buffer.alloc(0)),
    ).toBe(true);
    expect(native.destroy).not.toHaveBeenCalled();
    expect(hocuspocus.handleConnection).toHaveBeenCalledTimes(2);
  });

  test('under allowExternal consent, /collab/keepalive refuses a foreign Origin (CSWSH)', () => {
    // The keepalive channel gates on admitted() in every mode but historically
    // skipped Origin — the same hole as plain /collab, lower value (agent
    // presence + keepalive sockets, no CRDT). Under consent a foreign-origin
    // page passes peer + Host, so the Origin check is the CSWSH defense here too.
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      agentPresenceBroadcaster: { setPresence: vi.fn() } as never,
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1', '100.64.0.7'],
          externalUrl: 'https://kb.example.com',
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: false,
        },
      }),
    });

    // Attack: externalUrl Host is admitted, but the foreign Origin is refused.
    const attacker = createSocket();
    host.handleUpgrade(
      request(
        '/collab/keepalive?connectionId=agent_1&displayName=A&clientName=Claude&colorSeed=s',
        'kb.example.com',
        'https://evil.example',
      ),
      attacker as never,
      Buffer.alloc(0),
    );
    expect(attacker.destroy).toHaveBeenCalledOnce();

    // A native MCP client carrying no Origin is admitted.
    const nativeWs = new EventEmitter();
    callbackUpgrade(host, nativeWs);
    const native = createSocket();
    host.handleUpgrade(
      request(
        '/collab/keepalive?connectionId=agent_2&displayName=A&clientName=Claude&colorSeed=s',
        'kb.example.com',
      ),
      native as never,
      Buffer.alloc(0),
    );
    expect(native.destroy).not.toHaveBeenCalled();
  });

  test('under allowExternal consent, /collab/thread refuses a foreign Origin (CSWSH)', () => {
    // Completes the CSWSH matrix: /collab and /collab/keepalive have consent-mode
    // foreign-Origin tests; thread management is lower value but the same class.
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({
      hocuspocus,
      log,
      acpThreadManager: {} as never,
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1', '100.64.0.7'],
          externalUrl: 'https://kb.example.com',
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: false,
        },
      }),
    });

    // Attack: the externalUrl Host is admitted, but the foreign Origin is refused.
    const attacker = createSocket();
    host.handleUpgrade(
      request('/collab/thread', 'kb.example.com', 'https://evil.example'),
      attacker as never,
      Buffer.alloc(0),
    );
    expect(attacker.destroy).toHaveBeenCalledOnce();
    expect(hocuspocus.handleConnection).not.toHaveBeenCalled();

    // A first-party thread on the externalUrl origin is admitted (message wired).
    const threadWs = new EventEmitter() as EventEmitter & { close: () => void; send: () => void };
    threadWs.close = () => {};
    threadWs.send = () => {};
    callbackUpgrade(host, threadWs);
    const firstParty = createSocket();
    host.handleUpgrade(
      request('/collab/thread', 'kb.example.com', 'https://kb.example.com'),
      firstParty as never,
      Buffer.alloc(0),
    );
    expect(firstParty.destroy).not.toHaveBeenCalled();
    expect(threadWs.listenerCount('message')).toBe(1);
  });

  test('bootstraps presence only for a complete valid keepalive identity', () => {
    const log = createLog();
    const setPresence = vi.fn();
    const host = createCollaborationHost({
      hocuspocus: createHocuspocus(),
      log,
      agentPresenceBroadcaster: { setPresence } as never,
    });
    const validWs = new EventEmitter();
    callbackUpgrade(host, validWs);
    host.handleUpgrade(
      request(
        '/collab/keepalive?connectionId=agent_1&displayName=Agent&clientName=Claude&colorSeed=seed',
      ),
      createSocket() as never,
      Buffer.alloc(0),
    );
    const invalidWs = new EventEmitter();
    callbackUpgrade(host, invalidWs);
    host.handleUpgrade(
      request('/collab/keepalive?connectionId=bad%0Aid&displayName=Agent&clientName=Claude'),
      createSocket() as never,
      Buffer.alloc(0),
    );
    expect(setPresence).toHaveBeenCalledOnce();
    expect(setPresence).toHaveBeenCalledWith(
      'agent-agent_1',
      expect.objectContaining({ displayName: 'Agent' }),
    );
  });

  test('closes an oversized collaboration message with policy code 1009', () => {
    const handleMessage = vi.fn();
    const hocuspocus = {
      handleConnection: vi.fn(() => ({ handleMessage, handleClose: vi.fn() })),
      getConnectionsCount: vi.fn(() => 0),
    } as never;
    const host = createCollaborationHost({ hocuspocus, log: createLog() });
    const ws = new EventEmitter() as EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    ws.close = vi.fn();
    ws.terminate = vi.fn();
    callbackUpgrade(host, ws);

    host.handleUpgrade(request('/collab'), createSocket() as never, Buffer.alloc(0));
    ws.emit('message', Buffer.alloc(1024 * 1024 + 1));

    expect(ws.close).toHaveBeenCalledWith(1009, 'Message Too Big');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  test('routes unsupported-length WebSocket errors through the oversized-message path', () => {
    const log = createLog();
    const host = createCollaborationHost({ hocuspocus: createHocuspocus(), log });
    const ws = new EventEmitter() as EventEmitter & {
      terminate: ReturnType<typeof vi.fn>;
    };
    ws.terminate = vi.fn();
    callbackUpgrade(host, ws);
    host.handleUpgrade(request('/collab'), createSocket() as never, Buffer.alloc(0));

    ws.emit(
      'error',
      Object.assign(new Error('Max payload size exceeded'), {
        code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
      }),
    );

    expect(log.warn).toHaveBeenCalledWith(
      {
        event: 'collab-message-too-large',
        limit: 1024 * 1024,
      },
      'Collab WebSocket frame rejected by ws maxPayload before Yjs processing',
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  test('cancels keepalive cleanup when the same connection reconnects during grace', async () => {
    vi.useFakeTimers();
    try {
      const closeAllForAgent = vi.fn();
      const host = createCollaborationHost({
        hocuspocus: createHocuspocus(),
        log: createLog(),
        sessionManager: { closeAllForAgent } as never,
        keepaliveGraceMs: 1_000,
      });
      const firstWs = new EventEmitter();
      callbackUpgrade(host, firstWs);
      host.handleUpgrade(
        request('/collab/keepalive?connectionId=agent1'),
        createSocket() as never,
        Buffer.alloc(0),
      );
      firstWs.emit('close');

      const secondWs = new EventEmitter();
      callbackUpgrade(host, secondWs);
      host.handleUpgrade(
        request('/collab/keepalive?connectionId=agent1'),
        createSocket() as never,
        Buffer.alloc(0),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(closeAllForAgent).not.toHaveBeenCalled();
      await host.shutdown();
      secondWs.emit('close');
    } finally {
      vi.useRealTimers();
    }
  });

  test('contains synchronous upgrade throws and destroys the raw socket', () => {
    const log = createLog();
    const host = createCollaborationHost({ hocuspocus: createHocuspocus(), log });
    vi.spyOn(host.wss, 'handleUpgrade').mockImplementation(() => {
      throw new Error('upgrade failed');
    });
    const raw = createSocket();

    expect(host.handleUpgrade(request('/collab'), raw as never, Buffer.alloc(0))).toBe(true);
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
  });

  test('shares shutdown, drains sockets, cancels grace work, and awaits active cleanup', async () => {
    const log = createLog();
    const closeAllForAgent = vi.fn();
    const cleanup = Promise.withResolvers<void>();
    closeAllForAgent.mockReturnValue(cleanup.promise);
    const host = createCollaborationHost({
      hocuspocus: createHocuspocus(),
      log,
      sessionManager: { closeAllForAgent } as never,
      keepaliveGraceMs: 0,
    });
    const keepaliveWs = new EventEmitter();
    callbackUpgrade(host, keepaliveWs);
    const keepaliveRaw = createSocket();
    host.handleUpgrade(
      request('/collab/keepalive?connectionId=agent1'),
      keepaliveRaw as never,
      Buffer.alloc(0),
    );
    const bareWs = new EventEmitter();
    callbackUpgrade(host, bareWs);
    const bareRaw = createSocket();
    host.handleUpgrade(request('/collab'), bareRaw as never, Buffer.alloc(0));

    keepaliveWs.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeAllForAgent).toHaveBeenCalledOnce();
    const first = host.shutdown();
    expect(host.shutdown()).toBe(first);
    keepaliveWs.emit('close');
    expect(keepaliveRaw.destroy).toHaveBeenCalled();
    expect(bareRaw.destroy).toHaveBeenCalled();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanup.resolve();
    await first;
  });

  test('cancels a pending keepalive grace timer during shutdown', async () => {
    vi.useFakeTimers();
    const closeAllForAgent = vi.fn();
    const host = createCollaborationHost({
      hocuspocus: createHocuspocus(),
      log: createLog(),
      sessionManager: { closeAllForAgent } as never,
      keepaliveGraceMs: 1_000,
    });
    const keepaliveWs = new EventEmitter();
    callbackUpgrade(host, keepaliveWs);
    host.handleUpgrade(
      request('/collab/keepalive?connectionId=agent1'),
      createSocket() as never,
      Buffer.alloc(0),
    );

    keepaliveWs.emit('close');
    await host.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(closeAllForAgent).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('allows HTTP and WSS close after draining a live upgraded socket', async () => {
    const log = createLog();
    const hocuspocus = createHocuspocus();
    const host = createCollaborationHost({ hocuspocus, log });
    const httpServer = createServer();
    httpServer.on('upgrade', (req, socket, head) => host.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (typeof address !== 'object' || address === null) throw new Error('missing test port');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/collab`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    closers.push(async () => {
      client.terminate();
      await host.shutdown();
      await new Promise<void>((resolve) => host.wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    await withTimeout(host.shutdown());
    await withTimeout(new Promise<void>((resolve) => host.wss.close(() => resolve())));
    await withTimeout(new Promise<void>((resolve) => httpServer.close(() => resolve())));
    client.terminate();
    expect(hocuspocus.handleConnection).toHaveBeenCalledOnce();
  });
});
