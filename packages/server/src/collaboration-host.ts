import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hocuspocus } from '@hocuspocus/server';
import { AGENT_ICON_COLORS, colorFromSeed, iconFromClientName } from '@inkeep/open-knowledge-core';
import { WebSocketServer } from 'ws';
import type { AcpThreadManager } from './acp/thread-manager.ts';
import { attachAcpThreadSocket } from './acp/thread-socket.ts';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import { toBroadcasterKey, validateAgentId } from './agent-id.ts';
import type { AgentPresenceBroadcaster } from './agent-presence.ts';
import type { AgentSessionManager } from './agent-sessions.ts';
import {
  buildIngressPolicy,
  type IngressPolicy,
  isHostAdmitted,
  isOriginAdmitted,
  isPeerAdmitted,
  stampIngressContext,
  tripsForwardedHeaderTripwire,
} from './ingress-policy.ts';
import type { PinoLogger } from './logger.ts';
import type { MaintenanceCoordinator } from './maintenance-coordinator.ts';
import { handleCollabSocketError, incrementCollabMessageTooLarge } from './metrics.ts';

const DEFAULT_KEEPALIVE_GRACE_MS = 10_000;
const MAX_COLLAB_MESSAGE_BYTES = 1024 * 1024;
const MAX_KEEPALIVE_IDENTITY_LEN = 256;

export interface CollaborationHostOptions {
  hocuspocus: Hocuspocus;
  log: PinoLogger;
  sessionManager?: AgentSessionManager;
  agentFocusBroadcaster?: AgentFocusBroadcaster | null;
  agentPresenceBroadcaster?: AgentPresenceBroadcaster | null;
  maintenanceCoordinator?: MaintenanceCoordinator;
  keepaliveGraceMs?: number;
  acpThreadManager?: AcpThreadManager | null;
  /**
   * The boot-built ingress policy — the same object gating the HTTP surface,
   * so upgrades and requests can never disagree. Omitted (test rigs) ⇒ the
   * loopback-only default policy.
   */
  ingressPolicy?: IngressPolicy;
}

export interface CollaborationHost {
  readonly wss: WebSocketServer;
  readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  shutdown(): Promise<void>;
}

export interface KeepaliveIdentity {
  displayName: string;
  clientName: string;
  colorSeed: string;
}

export function parseKeepaliveConnectionId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return validateAgentId(new URL(url, 'http://localhost').searchParams.get('connectionId'));
  } catch {
    return null;
  }
}

function sanitizeIdentityField(raw: string | null): string | null {
  if (raw === null || raw.length === 0 || raw.length > MAX_KEEPALIVE_IDENTITY_LEN) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in awareness values
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

export function parseKeepaliveIdentity(url: string | undefined): KeepaliveIdentity | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, 'http://localhost');
    const displayName = sanitizeIdentityField(parsed.searchParams.get('displayName'));
    const clientName = sanitizeIdentityField(parsed.searchParams.get('clientName'));
    const colorSeed = sanitizeIdentityField(parsed.searchParams.get('colorSeed'));
    return displayName === null || clientName === null || colorSeed === null
      ? null
      : { displayName, clientName, colorSeed };
  } catch {
    return null;
  }
}

export function createCollaborationHost(options: CollaborationHostOptions): CollaborationHost {
  const {
    hocuspocus,
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    acpThreadManager,
  } = options;
  const ingressPolicy = options.ingressPolicy ?? buildIngressPolicy({});
  const keepaliveGraceMs = options.keepaliveGraceMs ?? DEFAULT_KEEPALIVE_GRACE_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_COLLAB_MESSAGE_BYTES });
  const keepaliveGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const keepaliveGraceInflight = new Set<Promise<void>>();
  const liveUpgradeSockets = new Set<Duplex>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  wss.on('error', (err) => log.error({ err }, 'WebSocketServer error'));

  // One admit shape for HTTP and WS: policy peer gate (loopback, or consent)
  // AND policy Host gate (loopback names + admitted public names). Covers the
  // legacy remote flow too — its tunnel host is in the policy's Host set and
  // its peers are loopback (the tunnel connects from loopback).
  const admitted = (req: IncomingMessage): boolean =>
    isPeerAdmitted(req.socket.remoteAddress, ingressPolicy) &&
    isHostAdmitted(
      Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host,
      ingressPolicy,
    );

  const trackSocket = (socket: Duplex, label: string): void => {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!handleCollabSocketError(err)) log.error({ err }, `${label} socket error`);
    });
    liveUpgradeSockets.add(socket);
    socket.once('close', () => liveUpgradeSockets.delete(socket));
  };

  const safelyHandleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    label: string,
    onConnection: Parameters<WebSocketServer['handleUpgrade']>[3],
  ): void => {
    try {
      wss.handleUpgrade(req, socket, head, onConnection);
    } catch (err) {
      log.error({ err, url: req.url }, `[collab] ${label} handleUpgrade threw`);
      try {
        socket.destroy();
      } catch {
        // Best effort for an already-destroyed upgrade socket.
      }
    }
  };

  const handleKeepalive = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Same CSWSH defense as `/collab/thread` and plain `/collab` (CWE-1275):
    // a present-but-foreign Origin is refused. Lower-value channel (agent
    // presence + session keepalive, no CRDT read/write), but the same class —
    // under consent a foreign-origin page passes peer + Host, so Origin is the
    // only signal that separates it from a first-party client. Unlike plain
    // `/collab`, keepalive runs `admitted()` in every mode, so the Origin check
    // rides along in every mode too; a missing Origin (native MCP clients)
    // stays admitted.
    if (
      !admitted(req) ||
      (req.headers.origin !== undefined && !isOriginAdmitted(req.headers.origin, ingressPolicy))
    ) {
      log.debug(
        { url: req.url, host: req.headers.host, origin: req.headers.origin },
        '[collab] /collab/keepalive upgrade refused',
      );
      socket.destroy();
      return;
    }
    trackSocket(socket, 'MCP keepalive');
    safelyHandleUpgrade(req, socket, head, 'keepalive', (ws) => {
      const connectionId = parseKeepaliveConnectionId(req.url);
      if (connectionId) {
        const existing = keepaliveGraceTimers.get(connectionId);
        if (existing !== undefined) {
          clearTimeout(existing);
          keepaliveGraceTimers.delete(connectionId);
          log.info({ connectionId }, '[keepalive] reconnect during grace — timer cancelled');
        }
      }
      if (connectionId && agentPresenceBroadcaster) {
        const identity = parseKeepaliveIdentity(req.url);
        if (identity) {
          try {
            const icon = iconFromClientName(identity.clientName);
            agentPresenceBroadcaster.setPresence(toBroadcasterKey(connectionId), {
              displayName: identity.displayName,
              icon,
              color: AGENT_ICON_COLORS[icon] ?? colorFromSeed(identity.colorSeed),
              // Presence filtering hides entries without `currentDoc`; this
              // non-document sentinel surfaces the agent before its first write.
              currentDoc: '(connected)',
              mode: 'idle',
              ts: Date.now(),
            });
          } catch (err) {
            log.error({ err, connectionId }, '[keepalive] presence bootstrap failed');
          }
        }
      }
      const pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {
          // The close/error callbacks dispose the dead socket.
        }
      }, 30_000);
      pingTimer.unref?.();
      // Refresh faster than the client-side 5 s TTL so an idle agent stays
      // visible between tool calls. Presence lives under `agent-<id>`; using
      // the raw URL id would make `bumpPresenceTs` a no-op.
      const tsRefreshTimer = connectionId
        ? setInterval(
            () => agentPresenceBroadcaster?.bumpPresenceTs(toBroadcasterKey(connectionId)),
            3_000,
          )
        : null;
      tsRefreshTimer?.unref?.();
      ws.on('close', () => {
        clearInterval(pingTimer);
        if (tsRefreshTimer !== null) clearInterval(tsRefreshTimer);
        if (!connectionId || shuttingDown) return;
        const timer = setTimeout(() => {
          keepaliveGraceTimers.delete(connectionId);
          // Shutdown may begin after this timer is scheduled but before it
          // fires; never race cleanup against session and broadcaster teardown.
          if (shuttingDown) return;
          const work = (async () => {
            log.info({ connectionId }, '[keepalive] grace expired — cleaning up sessions');
            try {
              await sessionManager?.closeAllForAgent(connectionId);
            } catch (err) {
              log.error({ err, connectionId }, '[keepalive] closeAllForAgent failed');
            }
            try {
              agentFocusBroadcaster?.clearFocus(connectionId);
            } catch (err) {
              log.error({ err, connectionId }, '[keepalive] clearFocus failed');
            }
            try {
              agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(connectionId));
            } catch (err) {
              log.error({ err, connectionId }, '[keepalive] clearPresence failed');
            }
            // A closed keepalive means its writer is dead, so maintenance can
            // evaluate off the write path. Flush-counter and boot maintenance
            // reap other session types; only `session-close` telemetry is
            // intentionally limited to keepalive-backed sessions.
            try {
              await maintenanceCoordinator?.onSessionClose();
            } catch (err) {
              log.error({ err, connectionId }, '[keepalive] maintenance onSessionClose failed');
            }
          })();
          keepaliveGraceInflight.add(work);
          void work.finally(() => keepaliveGraceInflight.delete(work));
        }, keepaliveGraceMs);
        timer.unref?.();
        keepaliveGraceTimers.set(connectionId, timer);
        log.info(
          { connectionId, graceMs: keepaliveGraceMs },
          '[keepalive] disconnected — grace timer started',
        );
      });
      ws.on('error', (err: NodeJS.ErrnoException) => {
        if (!handleCollabSocketError(err)) log.error({ err }, 'MCP keepalive WS error');
        ws.terminate();
      });
    });
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (!req.url?.startsWith('/collab')) return false;
    // These breadcrumbs locate a stalled upgrade: `upgrade received` reached
    // this host, `handleUpgrade starting` passed routing, `handleUpgrade threw`
    // marks a synchronous WS handoff failure, and `handshake complete` means
    // Hocuspocus owns the connection.
    log.info(
      {
        url: req.url,
        protocol: req.headers['sec-websocket-protocol'] ?? 'none',
        host: req.headers.host ?? 'none',
        origin: req.headers.origin ?? 'none',
      },
      '[collab] upgrade received',
    );
    // WS upgrades join the same ingress path as HTTP: stamp the shared
    // actor-carrying context, then run the same policy tripwire + predicates.
    stampIngressContext(req, {});
    if (tripsForwardedHeaderTripwire(req, ingressPolicy)) {
      log.warn(
        { url: req.url, host: req.headers.host },
        '[remote] refused proxied WS upgrade; consent with OK_ALLOW_EXTERNAL=1 + OK_PUBLIC_URL, or start with `ok start --remote <url>`',
      );
      socket.destroy();
      return true;
    }
    if (req.url.startsWith('/collab/thread')) {
      if (
        acpThreadManager === undefined ||
        acpThreadManager === null ||
        !admitted(req) ||
        (req.headers.origin !== undefined && !isOriginAdmitted(req.headers.origin, ingressPolicy))
      ) {
        log.debug(
          { url: req.url, host: req.headers.host, origin: req.headers.origin },
          '[collab] /collab/thread upgrade refused',
        );
        socket.destroy();
        return true;
      }
      trackSocket(socket, 'ACP thread');
      safelyHandleUpgrade(req, socket, head, 'thread', (ws) =>
        attachAcpThreadSocket(ws, acpThreadManager, log),
      );
      return true;
    }
    if (req.url.startsWith('/collab/keepalive')) {
      handleKeepalive(req, socket, head);
      return true;
    }
    // Two independent axes gate plain `/collab`:
    //
    // (1) CSWSH defense (CWE-1275) — UNCONDITIONAL, in every mode, exactly as
    //     `/collab/thread` and `/collab/keepalive` do it. WebSocket upgrades
    //     bypass CORS, and localhost is reachable from any origin, so even a
    //     pure-local server is exposed: a page on a foreign origin can open
    //     `ws://127.0.0.1:<port>/collab` (loopback peer + loopback Host both
    //     pass) and, without an Origin check, gain full CRDT read/write. A
    //     present-but-foreign Origin is the only browser-side signal that
    //     separates that attack from a first-party client, so refuse it in ALL
    //     modes. A missing Origin (native / server-to-server clients) is
    //     admitted — those are not CSWSH vectors and legitimately carry none.
    //
    // (2) Peer + Host admission (`admitted()`) — only when EXPOSED (legacy
    //     `--remote` OR `allowExternal`). Pure-local keeps its historical
    //     ungated posture on this axis — a deliberate carve-out from the
    //     read-posture hardening that Host-gates `/api` reads and content-
    //     asset serving in every mode: WS upgrades are not reachable from a
    //     rebound page without an Origin header, and axis (1) refuses the
    //     foreign-Origin shape unconditionally. Under consent the loopback
    //     bind no longer implies a loopback peer, so `admitted()` (loopback +
    //     bind literals + publicUrl, identical to the HTTP API gate) keeps
    //     direct-IP access matching what `/api` accepts.
    const foreignOrigin =
      req.headers.origin !== undefined && !isOriginAdmitted(req.headers.origin, ingressPolicy);
    const exposed = ingressPolicy.legacyRemote !== undefined || ingressPolicy.allowExternal;
    if (foreignOrigin || (exposed && !admitted(req))) {
      log.debug(
        { url: req.url, host: req.headers.host, origin: req.headers.origin },
        '[collab] /collab upgrade refused',
      );
      socket.destroy();
      return true;
    }
    trackSocket(socket, 'Upgrade');
    log.info({ url: req.url }, '[collab] handleUpgrade starting');
    safelyHandleUpgrade(req, socket, head, 'collaboration', (ws) => {
      const connectionsBefore = hocuspocus.getConnectionsCount?.() ?? -1;
      const clientConnection = hocuspocus.handleConnection(ws, req as unknown as Request);
      log.info({ url: req.url, connectionsBefore }, '[collab] handshake complete');
      let closedByPolicy = false;
      ws.on('message', (data: ArrayBuffer | Buffer) => {
        if (closedByPolicy) return;
        if (data.byteLength > MAX_COLLAB_MESSAGE_BYTES) {
          closedByPolicy = true;
          incrementCollabMessageTooLarge();
          log.warn(
            {
              event: 'collab-message-too-large',
              bytes: data.byteLength,
              limit: MAX_COLLAB_MESSAGE_BYTES,
            },
            'Collab WebSocket message rejected before Yjs processing',
          );
          ws.close(1009, 'Message Too Big');
          return;
        }
        clientConnection.handleMessage(new Uint8Array(data as Buffer));
      });
      ws.on('close', (code: number, reason: Buffer) =>
        clientConnection.handleClose({ code, reason: reason.toString() }),
      );
      ws.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
          incrementCollabMessageTooLarge();
          log.warn(
            { event: 'collab-message-too-large', limit: MAX_COLLAB_MESSAGE_BYTES },
            'Collab WebSocket frame rejected by ws maxPayload before Yjs processing',
          );
        } else if (!handleCollabSocketError(err)) {
          log.error({ err }, 'WebSocket error');
        }
        ws.terminate();
      });
    });
    return true;
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Socket destruction emits close events; set the guard first so those
      // callbacks cannot schedule fresh grace cleanup during teardown.
      shuttingDown = true;
      // Callers close WSS/HTTP after this promise. Live upgraded sockets would
      // keep those closes pending, while destroying them also drives WS cleanup.
      for (const socket of liveUpgradeSockets) {
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
      }
      liveUpgradeSockets.clear();
      for (const timer of keepaliveGraceTimers.values()) clearTimeout(timer);
      keepaliveGraceTimers.clear();
      await Promise.allSettled(keepaliveGraceInflight);
    })();
    return shutdownPromise;
  };

  return { wss, handleUpgrade, shutdown };
}
