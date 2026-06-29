import { randomUUID } from 'node:crypto';
import type {
  KeyringSmokeResult,
  UtilityDebugKeyringSmokeResultMessage,
} from '../utility/server-entry.ts';

type UtilityLike = {
  postMessage(msg: unknown): void;
};

interface PendingRequest {
  resolve: (result: KeyringSmokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  utility: UtilityLike;
}

interface DebugIpcDeps {
  resolveUtility: (sender: unknown) => UtilityLike | null;
  isDebugAllowed: () => boolean;
  timeoutMs?: number;
  generateCorrelationId?: () => string;
}

export interface DebugIpcHandle {
  requestKeyringSmoke(sender: unknown): Promise<KeyringSmokeResult>;
  handleUtilityMessage(msg: unknown): void;
  cancelPendingForUtility(utility: UtilityLike): void;
  pendingSize(): number;
}

export function createDebugIpc(deps: DebugIpcDeps): DebugIpcHandle {
  const pending = new Map<string, PendingRequest>();
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const genId = deps.generateCorrelationId ?? randomUUID;

  function settle(
    correlationId: string,
    outcome: { kind: 'ok'; result: KeyringSmokeResult } | { kind: 'err'; err: Error },
  ): void {
    const entry = pending.get(correlationId);
    if (!entry) return;
    pending.delete(correlationId);
    clearTimeout(entry.timer);
    if (outcome.kind === 'ok') {
      entry.resolve(outcome.result);
    } else {
      entry.reject(outcome.err);
    }
  }

  async function requestKeyringSmoke(sender: unknown): Promise<KeyringSmokeResult> {
    if (!deps.isDebugAllowed()) {
      throw new Error('debug-channel disabled in production');
    }
    const utility = deps.resolveUtility(sender);
    if (!utility) {
      throw new Error('debug-keyring-smoke: no utility process attached to this window');
    }
    const correlationId = genId();
    return new Promise<KeyringSmokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(correlationId, {
          kind: 'err',
          err: new Error(`debug-keyring-smoke: timed out after ${timeoutMs}ms`),
        });
      }, timeoutMs);
      pending.set(correlationId, { resolve, reject, timer, utility });
      try {
        utility.postMessage({ type: 'debug-keyring-smoke', correlationId });
      } catch (err) {
        settle(correlationId, { kind: 'err', err: err as Error });
      }
    });
  }

  function cancelPendingForUtility(utility: UtilityLike): void {
    const orphaned: string[] = [];
    for (const [correlationId, entry] of pending) {
      if (entry.utility === utility) orphaned.push(correlationId);
    }
    for (const correlationId of orphaned) {
      settle(correlationId, {
        kind: 'err',
        err: new Error('debug-keyring-smoke: utility exited before replying'),
      });
    }
  }

  function handleUtilityMessage(msg: unknown): void {
    const typed = msg as Partial<UtilityDebugKeyringSmokeResultMessage> | null | undefined;
    if (!typed || typed.type !== 'debug-keyring-smoke-result') return;
    if (typeof typed.correlationId !== 'string' || !typed.result) return;
    settle(typed.correlationId, { kind: 'ok', result: typed.result });
  }

  return {
    requestKeyringSmoke,
    handleUtilityMessage,
    cancelPendingForUtility,
    pendingSize: () => pending.size,
  };
}
