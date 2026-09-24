import { stripVTControlCharacters } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import {
  expectNoticeFromTrigger,
  type TransientNoticeObservation,
  type TransientNoticeRecorder,
  transientNoticeObservation,
} from './transient-notice';

const NOTICE = 'Agent panel closed to keep Terminal readable.';
const OTHER_NOTICE = 'Terminal closed to make room for the agent panel.';
const OBSERVE_BOUND_MS = 300;

function noticeSurface() {
  let observing = false;
  const observed: string[] = [];
  return {
    show(text: string): void {
      if (observing) observed.push(text);
    },
    observation(
      trigger: () => Promise<void>,
      startObserving: () => Promise<void> = () => {
        observing = true;
        return Promise.resolve();
      },
    ): TransientNoticeObservation {
      return {
        startObserving,
        trigger,
        readObserved: () => Promise.resolve([...observed]),
      };
    },
  };
}

async function rejectionOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => {
      throw new Error('the notice oracle resolved where it had to reject');
    },
    (error: unknown) =>
      stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
  );
}

describe('transient notice caused by a trigger', () => {
  test('replays CI retry 1: observes a notice shown and dismissed before the trigger returned', async () => {
    const surface = noticeSurface();

    await expectNoticeFromTrigger(
      NOTICE,
      surface.observation(() => {
        surface.show(NOTICE);
        return Promise.resolve();
      }),
      { timeout: OBSERVE_BOUND_MS },
    );
  });

  test('observes a notice that fires after the trigger returns', async () => {
    const surface = noticeSurface();

    await expectNoticeFromTrigger(
      NOTICE,
      surface.observation(() => {
        setTimeout(() => surface.show(NOTICE), 0);
        return Promise.resolve();
      }),
      { timeout: OBSERVE_BOUND_MS },
    );
  });

  test('fails naming the notice when the trigger shows none', async () => {
    const surface = noticeSurface();

    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        surface.observation(() => Promise.resolve()),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(message).toContain(NOTICE);
  });

  test('is not satisfied by a different notice the trigger showed', async () => {
    const surface = noticeSurface();

    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        surface.observation(() => {
          surface.show(OTHER_NOTICE);
          return Promise.resolve();
        }),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(message).toContain(NOTICE);
  });

  test('surfaces an observer that cannot start as that failure, not as a missing notice', async () => {
    const OBSERVER_FAILURE = 'the recorder could not be installed in the renderer';
    const surface = noticeSurface();

    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        surface.observation(
          () => {
            surface.show(NOTICE);
            return Promise.resolve();
          },
          () => Promise.reject(new Error(OBSERVER_FAILURE)),
        ),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(message).toContain(OBSERVER_FAILURE);
    expect(message).not.toMatch(/Received/u);
  });
});

const STOP_FAILURE = 'the notice recorder could not be disconnected';
const LIVENESS_BOUND_MS = 500;

function stoppable(
  observation: TransientNoticeObservation,
  stop: () => Promise<void> = () => Promise.resolve(),
) {
  let stops = 0;
  const stoppableObservation: TransientNoticeObservation = {
    ...observation,
    readObserved: () =>
      stops > 0
        ? Promise.reject(new Error('the notice record was read after the observer stopped'))
        : observation.readObserved(),
    stopObserving: () => {
      stops += 1;
      return stop();
    },
  };
  return { observation: stoppableObservation, stops: () => stops };
}

describe('transient notice observer teardown', () => {
  test('stops the observer once, after the notice was observed', async () => {
    const surface = noticeSurface();
    const observer = stoppable(
      surface.observation(() => {
        surface.show(NOTICE);
        return Promise.resolve();
      }),
    );

    await expectNoticeFromTrigger(NOTICE, observer.observation, { timeout: OBSERVE_BOUND_MS });

    expect(observer.stops()).toBe(1);
  });

  test('keeps the missing-notice verdict when stopping the observer also fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const surface = noticeSurface();
      const observer = stoppable(
        surface.observation(() => Promise.resolve()),
        () => Promise.reject(new Error(STOP_FAILURE)),
      );

      const message = await rejectionOf(
        expectNoticeFromTrigger(NOTICE, observer.observation, { timeout: OBSERVE_BOUND_MS }),
      );

      expect(observer.stops()).toBe(1);
      expect(message).toContain(NOTICE);
      expect(message).not.toContain(STOP_FAILURE);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(STOP_FAILURE));
    } finally {
      warn.mockRestore();
    }
  });

  test('surfaces a failure to stop the observer as itself once the notice was observed', async () => {
    const surface = noticeSurface();
    const observer = stoppable(
      surface.observation(() => {
        surface.show(NOTICE);
        return Promise.resolve();
      }),
      () => Promise.reject(new Error(STOP_FAILURE)),
    );

    const message = await rejectionOf(
      expectNoticeFromTrigger(NOTICE, observer.observation, { timeout: OBSERVE_BOUND_MS }),
    );

    expect(message).toContain(STOP_FAILURE);
    expect(message).not.toMatch(/Received/u);
  });
});

describe('transient notice observation bound', () => {
  test.each([
    ['a zero bound', 0],
    ['a NaN bound', Number.NaN],
    ['a negative bound', -1],
  ])(
    'rejects %s promptly by naming the positive-bound contract, before it arms or triggers anything',
    async (_label, timeout) => {
      let starts = 0;
      let triggers = 0;
      let raceOver = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const outcome = await Promise.race([
        expectNoticeFromTrigger(
          NOTICE,
          {
            startObserving: () => {
              starts += 1;
              return Promise.resolve();
            },
            trigger: () => {
              triggers += 1;
              return Promise.resolve();
            },
            readObserved: () =>
              raceOver
                ? Promise.reject(new Error('the liveness race is over'))
                : Promise.resolve([]),
          },
          { timeout },
        ).then(
          () => 'resolved',
          (error: unknown) =>
            stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still waiting'), LIVENESS_BOUND_MS);
        }),
      ]);
      raceOver = true;
      clearTimeout(timer);

      expect(outcome).toMatch(/positive/u);
      expect([starts, triggers]).toEqual([0, 0]);
    },
  );
});

type NoticeListener = (text: string) => void;

interface FakeRealm {
  readonly noticeRegion: { subscribe(listener: NoticeListener): () => void };
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  [key: string]: unknown;
}

interface FakeDocument {
  readonly window: FakeRealm;
  readonly document: { readonly body: { readonly innerText: string } };
  show(text: string): void;
  dismiss(text: string): void;
  subscriptionsOpened(): number;
  activeSubscriptions(): number;
}

function fakeDocument(pageSessionStorage: Map<string, string>): FakeDocument {
  const visible: string[] = [];
  const listeners = new Set<NoticeListener>();
  let opened = 0;
  return {
    window: {
      noticeRegion: {
        subscribe(listener) {
          listeners.add(listener);
          opened += 1;
          return () => {
            listeners.delete(listener);
          };
        },
      },
      sessionStorage: {
        getItem: (key) => pageSessionStorage.get(key) ?? null,
        setItem: (key, value) => {
          pageSessionStorage.set(key, value);
        },
      },
    },
    document: {
      body: {
        get innerText() {
          return visible.join('\n');
        },
      },
    },
    show(text) {
      visible.push(text);
      for (const listener of listeners) listener(text);
    },
    dismiss(text) {
      const at = visible.indexOf(text);
      if (at >= 0) visible.splice(at, 1);
    },
    subscriptionsOpened: () => opened,
    activeSubscriptions: () => listeners.size,
  };
}

function runInDocument<A, R>(target: FakeDocument, pageFunction: (arg: A) => R, arg: A): R {
  vi.stubGlobal('window', target.window);
  vi.stubGlobal('document', target.document);
  vi.stubGlobal('sessionStorage', target.window.sessionStorage);
  try {
    return structuredClone(pageFunction(structuredClone(arg)));
  } finally {
    vi.unstubAllGlobals();
  }
}

function documentAwarePage({ honoursInitScripts = true }: { honoursInitScripts?: boolean } = {}) {
  const pageSessionStorage = new Map<string, string>();
  const initScripts = new Set<(target: FakeDocument) => void>();
  let current = fakeDocument(pageSessionStorage);
  let bootApp: (booted: FakeDocument) => void = () => {};

  const page = {
    addInitScript<A>(script: (arg: A) => unknown, arg: A) {
      const registeredArg = structuredClone(arg);
      const runOnNewDocument = (target: FakeDocument): void => {
        runInDocument(target, script, registeredArg);
      };
      initScripts.add(runOnNewDocument);
      const dispose = (): Promise<void> => {
        initScripts.delete(runOnNewDocument);
        return Promise.resolve();
      };
      return Promise.resolve({ dispose, [Symbol.asyncDispose]: dispose });
    },
    evaluate<A, R>(pageFunction: (arg: A) => R, arg: A): Promise<R> {
      return Promise.resolve().then(() => runInDocument(current, pageFunction, arg));
    },
  };

  return {
    page: page as unknown as Parameters<typeof transientNoticeObservation>[0],
    current: () => current,
    whenBooted(boot: (booted: FakeDocument) => void): void {
      bootApp = boot;
    },
    reload(): Promise<void> {
      const reloaded = fakeDocument(pageSessionStorage);
      if (honoursInitScripts)
        for (const runOnNewDocument of initScripts) runOnNewDocument(reloaded);
      current = reloaded;
      bootApp(reloaded);
      return Promise.resolve();
    },
    activeInitScripts: () => initScripts.size,
  };
}

interface FakeRecord {
  readonly seen: string[];
  readonly release: () => void;
}

const realmRecorder: TransientNoticeRecorder = {
  record({ key, notices }) {
    const realm = window as unknown as FakeRealm;
    if (realm[key] !== undefined) return;
    const seen: string[] = [];
    const release = realm.noticeRegion.subscribe((text) => {
      if (notices.includes(text) && !seen.includes(text)) seen.push(text);
    });
    const record: FakeRecord = { seen, release };
    Object.defineProperty(realm, key, { value: record });
  },
  read(key) {
    const record = (window as unknown as FakeRealm)[key] as FakeRecord | undefined;
    return record === undefined ? null : [...record.seen];
  },
  stop(key) {
    ((window as unknown as FakeRealm)[key] as FakeRecord | undefined)?.release();
  },
};

const showsAndRemoves = (target: FakeDocument, text: string): void => {
  target.show(text);
  target.dismiss(text);
};

describe('transient notice observed in the document its trigger produced', () => {
  test('replays CI retry 1: next-document arming observes a notice the reloaded document shows and removes before the reload resolves', async () => {
    const tab = documentAwarePage();
    tab.whenBooted((reloaded) => showsAndRemoves(reloaded, NOTICE));

    await expectNoticeFromTrigger(
      NOTICE,
      transientNoticeObservation(tab.page, {
        document: 'next',
        trigger: () => tab.reload(),
        recorder: realmRecorder,
      }),
      { timeout: OBSERVE_BOUND_MS },
    );
  });

  test('is never satisfied by a notice the pre-reload document was showing when observation armed', async () => {
    const tab = documentAwarePage();
    tab.current().show(NOTICE);

    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        transientNoticeObservation(tab.page, {
          document: 'next',
          trigger: () => tab.reload(),
          recorder: realmRecorder,
        }),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(tab.current().subscriptionsOpened()).toBeGreaterThan(0);
    expect(message).toContain(NOTICE);
    expect(message).not.toMatch(/not installed/u);
  });

  test('reports a reloaded document the recorder never reached as a missing recorder, never as a missing notice', async () => {
    const tab = documentAwarePage({ honoursInitScripts: false });
    tab.whenBooted((reloaded) => showsAndRemoves(reloaded, NOTICE));

    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        transientNoticeObservation(tab.page, {
          document: 'next',
          trigger: () => tab.reload(),
          recorder: realmRecorder,
        }),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(message).toMatch(/recorder\b.*\bnot installed/u);
    expect(message).not.toMatch(/Received/u);
  });

  test('current-document arming ignores a notice already on screen when it armed', async () => {
    const tab = documentAwarePage();
    tab.current().show(NOTICE);

    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        transientNoticeObservation(tab.page, {
          document: 'current',
          trigger: () => Promise.resolve(),
          recorder: realmRecorder,
        }),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(tab.current().subscriptionsOpened()).toBeGreaterThan(0);
    expect(message).toContain(NOTICE);
    expect(message).not.toMatch(/not installed/u);
  });

  test('current-document arming records a notice the trigger shows and removes', async () => {
    const tab = documentAwarePage();

    await expectNoticeFromTrigger(
      NOTICE,
      transientNoticeObservation(tab.page, {
        document: 'current',
        trigger: () => {
          showsAndRemoves(tab.current(), NOTICE);
          return Promise.resolve();
        },
        recorder: realmRecorder,
      }),
      { timeout: OBSERVE_BOUND_MS },
    );
  });

  test('gives each observation its own record, so a notice an earlier observation recorded never satisfies a later one', async () => {
    const tab = documentAwarePage();
    const observeCurrent = (trigger: () => Promise<void>) =>
      transientNoticeObservation(tab.page, {
        document: 'current',
        trigger,
        recorder: realmRecorder,
      });

    await expectNoticeFromTrigger(
      NOTICE,
      observeCurrent(() => {
        showsAndRemoves(tab.current(), NOTICE);
        return Promise.resolve();
      }),
      { timeout: OBSERVE_BOUND_MS },
    );
    const message = await rejectionOf(
      expectNoticeFromTrigger(
        NOTICE,
        observeCurrent(() => Promise.resolve()),
        { timeout: OBSERVE_BOUND_MS },
      ),
    );

    expect(message).toContain(NOTICE);
    expect(message).not.toMatch(/not installed/u);
  });

  test('disposes the init script and disconnects the recorder once the reload notice is judged', async () => {
    const tab = documentAwarePage();
    tab.whenBooted((reloaded) => showsAndRemoves(reloaded, NOTICE));

    await expectNoticeFromTrigger(
      NOTICE,
      transientNoticeObservation(tab.page, {
        document: 'next',
        trigger: () => tab.reload(),
        recorder: realmRecorder,
      }),
      { timeout: OBSERVE_BOUND_MS },
    );

    expect(tab.activeInitScripts()).toBe(0);
    expect(tab.current().activeSubscriptions()).toBe(0);
  });

  test('disconnects the recorder once an in-document notice is judged', async () => {
    const tab = documentAwarePage();

    await expectNoticeFromTrigger(
      NOTICE,
      transientNoticeObservation(tab.page, {
        document: 'current',
        trigger: () => {
          showsAndRemoves(tab.current(), NOTICE);
          return Promise.resolve();
        },
        recorder: realmRecorder,
      }),
      { timeout: OBSERVE_BOUND_MS },
    );

    expect(tab.current().activeSubscriptions()).toBe(0);
  });
});
