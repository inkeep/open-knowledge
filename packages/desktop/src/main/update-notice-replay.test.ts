import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import {
  deliverUpdateNoticesToLoadedWindows,
  type LoadStateWebContents,
  replayUpdateNoticesOnEveryLoad,
  type UpdateNoticeReplayTarget,
  type UpdateNoticeSource,
} from './update-notice-replay.ts';

interface Sent {
  channel: string;
  payload: unknown;
}

function makeWebContents() {
  const emitter = new EventEmitter();
  const sent: Sent[] = [];
  let destroyed = false;
  const webContents: UpdateNoticeReplayTarget = {
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, payload: args[0] });
    },
    isDestroyed: () => destroyed,
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
  };
  return {
    webContents,
    sent,
    load: () => emitter.emit('did-finish-load'),
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed');
    },
    loadListenerCount: () => emitter.listenerCount('did-finish-load'),
  };
}

function makeSource(initial: {
  pending?: { version: string } | null;
  whatsNew?: { version: string; releaseUrl: string } | null;
}): UpdateNoticeSource & {
  pending: { version: string } | null;
  whatsNew: { version: string; releaseUrl: string } | null;
} {
  const source = {
    pending: initial.pending ?? null,
    whatsNew: initial.whatsNew ?? null,
    getPendingUpdate: () => source.pending,
    getActiveWhatsNew: () => source.whatsNew,
  };
  return source;
}

describe('replayUpdateNoticesOnEveryLoad', () => {
  test('sends nothing until the page finishes loading', () => {
    const wc = makeWebContents();
    replayUpdateNoticesOnEveryLoad(wc.webContents, () =>
      makeSource({ pending: { version: '1.2.3' } }),
    );
    expect(wc.sent).toEqual([]);
  });

  test('every load, reloads included, re-delivers the card the source offers', () => {
    const wc = makeWebContents();
    const source = makeSource({ pending: { version: '1.2.3' } });
    replayUpdateNoticesOnEveryLoad(wc.webContents, () => source);

    wc.load();
    wc.load();
    wc.load();

    expect(wc.sent).toEqual([
      { channel: 'ok:update:downloaded', payload: { version: '1.2.3' } },
      { channel: 'ok:update:downloaded', payload: { version: '1.2.3' } },
      { channel: 'ok:update:downloaded', payload: { version: '1.2.3' } },
    ]);
  });

  test('asks the source at load time, so a withdrawn card is not replayed', () => {
    const wc = makeWebContents();
    const source = makeSource({ pending: { version: '1.2.3' } });
    replayUpdateNoticesOnEveryLoad(wc.webContents, () => source);
    wc.load();

    source.pending = null;
    wc.load();

    expect(wc.sent).toEqual([{ channel: 'ok:update:downloaded', payload: { version: '1.2.3' } }]);
  });

  test('replays the active release-notes card too', () => {
    const wc = makeWebContents();
    const whatsNew = { version: '1.2.2', releaseUrl: 'https://example.test/r/1.2.2' };
    replayUpdateNoticesOnEveryLoad(wc.webContents, () => makeSource({ whatsNew }));

    wc.load();
    wc.load();

    expect(wc.sent).toEqual([
      { channel: 'ok:update:whats-new', payload: whatsNew },
      { channel: 'ok:update:whats-new', payload: whatsNew },
    ]);
  });

  test('sends nothing while there is no source', () => {
    const wc = makeWebContents();
    replayUpdateNoticesOnEveryLoad(wc.webContents, () => null);
    wc.load();
    expect(wc.sent).toEqual([]);
  });

  test('attaching twice still delivers once per load', () => {
    const wc = makeWebContents();
    const source = makeSource({ pending: { version: '1.2.3' } });
    replayUpdateNoticesOnEveryLoad(wc.webContents, () => source);
    replayUpdateNoticesOnEveryLoad(wc.webContents, () => source);

    wc.load();

    expect(wc.loadListenerCount()).toBe(1);
    expect(wc.sent).toHaveLength(1);
  });

  test('drops its load listener when the web contents is destroyed', () => {
    const wc = makeWebContents();
    replayUpdateNoticesOnEveryLoad(wc.webContents, () =>
      makeSource({ pending: { version: '1.2.3' } }),
    );
    expect(wc.loadListenerCount()).toBe(1);

    wc.destroy();

    expect(wc.loadListenerCount()).toBe(0);
  });
});

function makeLoadState(state: { loading: boolean; url: string; destroyed?: boolean }) {
  const sent: Sent[] = [];
  const webContents: LoadStateWebContents = {
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, payload: args[0] });
    },
    isDestroyed: () => state.destroyed === true,
    isLoading: () => state.loading,
    getURL: () => state.url,
  };
  return { webContents, sent };
}

describe('deliverUpdateNoticesToLoadedWindows', () => {
  test('delivers only to windows whose page already finished loading', () => {
    const loaded = makeLoadState({ loading: false, url: 'app://ok/index.html' });
    const loading = makeLoadState({ loading: true, url: 'app://ok/index.html' });
    const blank = makeLoadState({ loading: false, url: '' });
    const destroyed = makeLoadState({ loading: false, url: 'app://ok/', destroyed: true });

    deliverUpdateNoticesToLoadedWindows(
      [loaded.webContents, loading.webContents, blank.webContents, destroyed.webContents],
      makeSource({ pending: { version: '1.2.3' } }),
    );

    expect(loaded.sent).toEqual([
      { channel: 'ok:update:downloaded', payload: { version: '1.2.3' } },
    ]);
    expect(loading.sent).toEqual([]);
    expect(blank.sent).toEqual([]);
    expect(destroyed.sent).toEqual([]);
  });

  test('sends nothing without a source', () => {
    const loaded = makeLoadState({ loading: false, url: 'app://ok/index.html' });
    deliverUpdateNoticesToLoadedWindows([loaded.webContents], null);
    expect(loaded.sent).toEqual([]);
  });
});
