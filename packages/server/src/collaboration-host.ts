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
      } catch {}
    }
  };

  const handleKeepalive = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
              currentDoc: '(connected)',
              mode: 'idle',
              ts: Date.now(),
              docTs: Date.now(),
            });
          } catch (err) {
            log.error({ err, connectionId }, '[keepalive] presence bootstrap failed');
          }
        }
      }
      const pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {}
      }, 30_000);
      pingTimer.unref?.();
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
    log.info(
      {
        url: req.url,
        protocol: req.headers['sec-websocket-protocol'] ?? 'none',
        host: req.headers.host ?? 'none',
        origin: req.headers.origin ?? 'none',
      },
      '[collab] upgrade received',
    );
    stampIngressContext(req, {});
    if (tripsForwardedHeaderTripwire(req, ingressPolicy)) {
      log.warn(
        { url: req.url, host: req.headers.host },
        '[remote] refused proxied WS upgrade; consent with OK_ALLOW_EXTERNAL=1 + OK_EXTERNAL_URL (or server.allowExternal + server.externalUrl in config)',
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
    const foreignOrigin =
      req.headers.origin !== undefined && !isOriginAdmitted(req.headers.origin, ingressPolicy);
    const exposed = ingressPolicy.allowExternal;
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
      shuttingDown = true;
      for (const socket of liveUpgradeSockets) {
        try {
          socket.destroy();
        } catch {}
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
