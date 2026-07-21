/**
 * `/collab/thread` WebSocket — frame routing between one connected client
 * and the `AcpThreadManager`.
 *
 * The socket carries the wire protocol defined in core's
 * `acp/thread-protocol.ts`: structured JSON frames both ways, with
 * per-thread event replay driven by `subscribe { sinceSeq }`. Gating
 * (loopback + workspace-host) happens at the upgrade site in
 * `mcp-mount.ts` / the dev Vite plugin — by the time this module sees a
 * socket it is trusted to the same level as the mutating HTTP surface.
 */

import type { ThreadServerFrame } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { parseThreadClientFrame } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { PinoLogger } from '../logger.ts';
import { type AcpThreadManager, ThreadOpError } from './thread-manager.ts';

/** Minimal structural WS shape (matches `ws`'s WebSocket where we need it). */
interface ThreadSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export function attachAcpThreadSocket(
  ws: ThreadSocket,
  manager: AcpThreadManager,
  log: PinoLogger,
): void {
  const subscriptions = new Map<string, (frame: ThreadServerFrame) => void>();

  const send = (frame: ThreadServerFrame): void => {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log.warn({ err }, '[acp-thread-socket] send failed');
    }
  };

  const sendError = (
    code: Parameters<typeof errorFrame>[0],
    message: string,
    extra?: { reqId?: string; threadId?: string },
  ): void => send(errorFrame(code, message, extra));

  ws.on('message', (data) => {
    const raw =
      typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
    const frame = parseThreadClientFrame(raw);
    if (frame === null) {
      sendError('bad-frame', 'unrecognized frame');
      return;
    }
    void (async () => {
      try {
        switch (frame.op) {
          case 'list': {
            send({ op: 'threads', threads: manager.listThreads() });
            return;
          }
          case 'create': {
            const info = await manager.createThread({
              agent: frame.agent,
              prompt: frame.prompt,
              docName: frame.docName,
              titleHint: frame.titleHint,
            });
            send({ op: 'created', reqId: frame.reqId, info });
            // Creating implies interest: auto-subscribe from the beginning
            // so the creator renders the spawn/handshake status events.
            await subscribeTo(info.threadId, 0);
            return;
          }
          case 'subscribe': {
            await subscribeTo(frame.threadId, frame.sinceSeq ?? 0);
            return;
          }
          case 'resume': {
            const info = await manager.resumeThread(frame.threadId, frame.prompt);
            send({ op: 'resumed', reqId: frame.reqId, info });
            // Resuming implies interest, same as create. Usually a no-op —
            // the client opened (and subscribed to) the archived tab first.
            await subscribeTo(frame.threadId, 0);
            return;
          }
          case 'delete': {
            const sink = subscriptions.get(frame.threadId);
            if (sink !== undefined) {
              manager.unsubscribe(frame.threadId, sink);
              subscriptions.delete(frame.threadId);
            }
            await manager.deleteThread(frame.threadId);
            send({ op: 'threads', threads: manager.listThreads() });
            return;
          }
          case 'unsubscribe': {
            const sink = subscriptions.get(frame.threadId);
            if (sink !== undefined) {
              manager.unsubscribe(frame.threadId, sink);
              subscriptions.delete(frame.threadId);
            }
            return;
          }
          case 'prompt': {
            manager.sendPrompt(frame.threadId, frame.content);
            return;
          }
          case 'permission_response': {
            manager.respondPermission(frame.threadId, frame.requestId, frame.outcome);
            return;
          }
          case 'runtime_consent_response': {
            manager.respondRuntimeConsent(frame.threadId, frame.requestId, frame.outcome);
            return;
          }
          case 'cancel': {
            manager.cancel(frame.threadId);
            return;
          }
          case 'set_mode': {
            manager.setMode(frame.threadId, frame.modeId);
            return;
          }
          case 'rename': {
            await manager.renameThread(frame.threadId, frame.title);
            return;
          }
          case 'set_config_option': {
            manager.setConfigOption(frame.threadId, frame.configId, frame.value);
            return;
          }
          case 'close': {
            const sink = subscriptions.get(frame.threadId);
            if (sink !== undefined) {
              manager.unsubscribe(frame.threadId, sink);
              subscriptions.delete(frame.threadId);
            }
            await manager.closeThread(frame.threadId);
            send({ op: 'threads', threads: manager.listThreads() });
            return;
          }
        }
      } catch (err) {
        if (err instanceof ThreadOpError) {
          sendError(err.code, err.message, {
            reqId: 'reqId' in frame ? frame.reqId : undefined,
            threadId: 'threadId' in frame ? frame.threadId : undefined,
          });
        } else {
          log.error({ err, op: frame.op }, '[acp-thread-socket] frame handling failed');
          sendError('internal', 'internal error', {
            reqId: 'reqId' in frame ? (frame as { reqId?: string }).reqId : undefined,
          });
        }
      }
    })();
  });

  const subscribeTo = async (threadId: string, sinceSeq: number): Promise<void> => {
    if (subscriptions.has(threadId)) return;
    const sink = (frame: ThreadServerFrame): void => send(frame);
    // Claim the slot BEFORE the async replay so a racing second subscribe
    // for the same thread no-ops instead of double-attaching.
    subscriptions.set(threadId, sink);
    try {
      // Replay happens inside subscribe() through the sink, AFTER the
      // subscribed frame below has announced the replay window start.
      const info = manager.getInfo(threadId);
      if (info === undefined) {
        subscriptions.delete(threadId);
        sendError('unknown-thread', `no thread '${threadId}'`, { threadId });
        return;
      }
      send({ op: 'subscribed', threadId, fromSeq: Math.max(sinceSeq, 0), info });
      await manager.subscribe(threadId, sinceSeq, sink);
    } catch (err) {
      subscriptions.delete(threadId);
      if (err instanceof ThreadOpError) {
        sendError(err.code, err.message, { threadId });
      } else {
        throw err;
      }
    }
  };

  ws.on('close', () => {
    for (const [threadId, sink] of subscriptions) {
      manager.unsubscribe(threadId, sink);
    }
    subscriptions.clear();
  });
  ws.on('error', (err) => {
    log.warn({ err }, '[acp-thread-socket] socket error');
  });
}

function errorFrame(
  code:
    | 'bad-frame'
    | 'unknown-thread'
    | 'unknown-agent'
    | 'capacity'
    | 'spawn-failed'
    | 'install-failed'
    | 'agent-error'
    | 'not-ready'
    | 'resume-unsupported'
    | 'internal',
  message: string,
  extra?: { reqId?: string; threadId?: string },
): ThreadServerFrame {
  return { op: 'error', code, message, ...extra };
}
