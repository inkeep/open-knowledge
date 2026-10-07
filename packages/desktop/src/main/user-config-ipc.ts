import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ConfigPatch, LanguagePreference } from '@inkeep/open-knowledge-core';
import type {
  OkUserConfigPatchResult,
  OkUserConfigSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import type { UserConfigDispatchRequest } from '../shared/ipc-channels.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import { type DesktopLogger, getLogger } from './desktop-logger.ts';

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface UserConfigStore {
  read(): Promise<OkUserConfigSnapshot>;
  patch(patch: ConfigPatch): Promise<OkUserConfigPatchResult>;
  watch(onChange: (snapshot: OkUserConfigSnapshot) => void): () => void;
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

function readTextOrEmptySync(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

type UserConfigLog = Pick<DesktopLogger, 'info' | 'warn'>;

function createFailureEpisode(log: UserConfigLog, event: string) {
  let failing = false;
  return {
    failed(err: unknown, context: Record<string, unknown> = {}): void {
      if (failing) return;
      failing = true;
      log.warn({ err, ...context }, `${event} failed`);
    },
    succeeded(context: Record<string, unknown> = {}): void {
      if (!failing) return;
      failing = false;
      log.info(context, `${event} recovered`);
    },
  };
}

function isPatchObject(value: unknown): value is ConfigPatch {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createUserConfigStore(opts: {
  homedir: string;
  pollIntervalMs?: number;
  log?: UserConfigLog;
}): UserConfigStore {
  const path = resolveConfigPath('user', opts.homedir, opts.homedir);
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = opts.log ?? getLogger('user-config');
  const readEpisode = createFailureEpisode(log, 'user config read');

  async function readTracked(source: string): Promise<string> {
    try {
      const text = await readTextOrEmpty(path);
      readEpisode.succeeded({ source });
      return text;
    } catch (err) {
      readEpisode.failed(err, { source });
      throw err;
    }
  }

  return {
    async read() {
      return { text: await readTracked('read') };
    },

    async patch(patch) {
      if (!isPatchObject(patch)) {
        return { ok: false, error: { code: 'WRITE_ERROR', detail: 'Patch must be an object.' } };
      }
      const result = await writeConfigPatch({
        cwd: opts.homedir,
        scope: 'user',
        patch,
        homedirOverride: opts.homedir,
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, text: await readTracked('patch') };
    },

    watch(onChange) {
      const deliveryEpisode = createFailureEpisode(log, 'user config change delivery');
      let last: string | null = null;
      try {
        last = readTextOrEmptySync(path);
        readEpisode.succeeded({ source: 'watch' });
      } catch (err) {
        readEpisode.failed(err, { source: 'watch' });
      }
      let stopped = false;
      let reading = false;
      let settling: string | null = null;
      const deliver = (text: string) => {
        if (stopped) return;
        if (text === last) {
          settling = null;
          return;
        }
        if (text !== settling) {
          settling = text;
          return;
        }
        settling = null;
        try {
          onChange({ text });
        } catch (err) {
          deliveryEpisode.failed(err);
          return;
        }
        deliveryEpisode.succeeded();
        last = text;
      };
      const poll = () => {
        if (reading) return;
        reading = true;
        readTracked('poll')
          .then(deliver, () => {})
          .finally(() => {
            reading = false;
          });
      };
      const timer = setInterval(poll, interval);
      timer.unref?.();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

export interface UserConfigSubscriber extends SendableWebContents {
  once(event: 'destroyed', listener: () => void): void;
}

export function createUserConfigDispatch(deps: {
  store: UserConfigStore;
  setLanguagePreference: (preference: LanguagePreference) => void;
}) {
  const subscriptions = new Map<UserConfigSubscriber, { stop: () => void; count: number }>();

  function release(sender: UserConfigSubscriber): void {
    subscriptions.get(sender)?.stop();
    subscriptions.delete(sender);
  }

  function subscribe(sender: UserConfigSubscriber): void {
    const existing = subscriptions.get(sender);
    if (existing) {
      existing.count += 1;
      return;
    }
    const stop = deps.store.watch((snapshot) => {
      if (sender.isDestroyed?.() === true) return;
      sendToRenderer(sender, 'ok:user-config:changed', snapshot);
    });
    subscriptions.set(sender, { stop, count: 1 });
    sender.once('destroyed', () => release(sender));
  }

  function unsubscribe(sender: UserConfigSubscriber): void {
    const existing = subscriptions.get(sender);
    if (!existing) return;
    existing.count -= 1;
    if (existing.count <= 0) release(sender);
  }

  return async function dispatch(
    sender: UserConfigSubscriber,
    request: UserConfigDispatchRequest,
  ): Promise<{ ok: true } | OkUserConfigSnapshot | OkUserConfigPatchResult> {
    switch (request?.kind) {
      case 'set-language-preference':
        deps.setLanguagePreference(request.preference);
        return { ok: true };
      case 'read':
        return deps.store.read();
      case 'subscribe':
        subscribe(sender);
        return { ok: true };
      case 'unsubscribe':
        unsubscribe(sender);
        return { ok: true };
      case 'patch':
        return deps.store.patch(request.patch);
      default:
        return rejectUnknownRequest(request);
    }
  };
}

function rejectUnknownRequest(_request: never): never {
  throw new Error('Unknown user-config request.');
}
