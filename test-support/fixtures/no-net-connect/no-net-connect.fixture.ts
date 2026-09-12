import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type DispatcherRequestInit,
  expectBlockedNetworkRequest,
  NetConnectBlockedError,
} from '../../no-net-connect';

const dispatcher = new Agent({
  connect: {
    lookup(_hostname, _options, callback) {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    },
  },
});

async function captureBlockedRequest(hostname: string): Promise<unknown> {
  return fetch(`http://${hostname}:4/resource`, {
    dispatcher,
  } as DispatcherRequestInit).catch((error: unknown) => error);
}

afterAll(() => dispatcher.close());

if (process.env.OK_FIXTURE_COLLECTION_BLOCK === '1') {
  try {
    await fetch('https://collection-time.invalid/resource');
  } catch {}
}

test('swallowed undeclared forbidden fetch fails', async () => {
  await captureBlockedRequest('undeclared.invalid');
});

test('declared exact hostname block passes', async () => {
  expectBlockedNetworkRequest('expected.invalid');
  const error = await captureBlockedRequest('expected.invalid');
  expect(error).toBeInstanceOf(NetConnectBlockedError);
});

test('unused hostname expectation fails', () => {
  expectBlockedNetworkRequest('unused.invalid');
});

test('mismatched hostname expectation fails', async () => {
  expectBlockedNetworkRequest('expected.invalid');
  const error = await captureBlockedRequest('actual.invalid');
  expect(error).toBeInstanceOf(NetConnectBlockedError);
});

test('ordinary assertion and swallowed forbidden fetch both surface', async () => {
  await captureBlockedRequest('combined-failure.invalid');
  expect('ordinary-actual').toBe('ordinary-expected');
});

describe('suite setup swallowed block fails', () => {
  beforeAll(async () => {
    await captureBlockedRequest('suite-setup.invalid');
  });

  test('suite body completes', () => {
    expect(true).toBe(true);
  });
});

describe('suite teardown swallowed block fails', () => {
  afterAll(async () => {
    await captureBlockedRequest('suite-teardown.invalid');
  });

  test('suite body completes', () => {
    expect(true).toBe(true);
  });
});

describe('suite hook declarations cannot authorize sibling suite blocks', () => {
  describe('declaration sibling', () => {
    let rejection: unknown;

    beforeAll(() => {
      try {
        expectBlockedNetworkRequest('cross-suite.invalid');
      } catch (error) {
        rejection = error;
      }
    });

    test('declaration rejection body passes', () => {
      expect(rejection).toEqual(
        new Error('Expected network blocks must be declared inside a test, not suite hooks'),
      );
    });
  });

  describe('blocking sibling', () => {
    beforeAll(async () => {
      await captureBlockedRequest('cross-suite.invalid');
    });

    test('swallowed block body passes', () => {
      expect(true).toBe(true);
    });
  });
});

describe('a block that lands after its scope drained is reported, not enforced', () => {
  test('schedules a forbidden fetch that lands after it returns', () => {
    setTimeout(() => {
      void fetch('https://orphan.invalid/resource').catch(() => {});
    }, 10);
  });

  test('schedules a late declaration that cannot re-open its scope', () => {
    setTimeout(() => {
      expectBlockedNetworkRequest('late-declaration.invalid');
      void fetch('https://late-declaration.invalid/resource').catch(() => {});
    }, 10);
  });

  test('a later test gives the orphan time to land', async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
});

test('unrelated console error passes', () => {
  console.error('fixture diagnostic unrelated to network blocking');
});

describe('concurrent siblings isolate exact hostname expectations', () => {
  let releaseAlpha: (() => void) | undefined;
  let releaseBeta: (() => void) | undefined;
  const alphaDeclared = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  const betaDeclared = new Promise<void>((resolve) => {
    releaseBeta = resolve;
  });

  test.concurrent('alpha request', async () => {
    expectBlockedNetworkRequest('alpha.invalid');
    releaseAlpha?.();
    await betaDeclared;
    const error = await captureBlockedRequest('alpha.invalid');
    expect(error).toBeInstanceOf(NetConnectBlockedError);
  });

  test.concurrent('beta request', async () => {
    await alphaDeclared;
    expectBlockedNetworkRequest('beta.invalid');
    releaseBeta?.();
    const error = await captureBlockedRequest('beta.invalid');
    expect(error).toBeInstanceOf(NetConnectBlockedError);
  });
});

describe('concurrent unexpected block stays with its owning test', () => {
  let releaseOffenderStarted: (() => void) | undefined;
  let releaseInnocentReady: (() => void) | undefined;
  let releaseOffenderBlocked: (() => void) | undefined;
  let releaseInnocentDone: (() => void) | undefined;
  const offenderStarted = new Promise<void>((resolve) => {
    releaseOffenderStarted = resolve;
  });
  const innocentReady = new Promise<void>((resolve) => {
    releaseInnocentReady = resolve;
  });
  const offenderBlocked = new Promise<void>((resolve) => {
    releaseOffenderBlocked = resolve;
  });
  const innocentDone = new Promise<void>((resolve) => {
    releaseInnocentDone = resolve;
  });

  test.concurrent('offender swallows its unexpected block', async () => {
    releaseOffenderStarted?.();
    await innocentReady;
    await captureBlockedRequest('concurrent-offender.invalid');
    releaseOffenderBlocked?.();
    await innocentDone;
  });

  test.concurrent('innocent sibling passes', async () => {
    await offenderStarted;
    releaseInnocentReady?.();
    await offenderBlocked;
    expect(true).toBe(true);
    releaseInnocentDone?.();
  });
});
