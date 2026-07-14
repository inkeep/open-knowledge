import { describe, expect, test } from 'bun:test';
import { createRemoteSessionCleanup } from './remote-session-lifecycle.ts';

function makeHarness(authoritative = true) {
  const events: string[] = [];
  const cleanup = createRemoteSessionCleanup({
    closeAttachedWindows: () => events.push('terminals'),
    closeTransport: () => events.push('transport'),
    isAuthoritative: () => authoritative,
    releaseAuthority: () => events.push('fingerprint'),
  });
  return { cleanup, events };
}

describe('remote session cleanup', () => {
  test('an uncommitted dedup/failure closes only its fresh transport', () => {
    const { cleanup, events } = makeHarness();

    cleanup.close();

    expect(events).toEqual(['transport']);
  });

  test('a committed authoritative session closes terminals before its transport and fingerprint', () => {
    const { cleanup, events } = makeHarness();
    cleanup.commit();

    cleanup.close();

    expect(events).toEqual(['terminals', 'transport', 'fingerprint']);
  });

  test('a committed session that lost authority closes only its own transport', () => {
    const { cleanup, events } = makeHarness(false);
    cleanup.commit();

    cleanup.close();

    expect(events).toEqual(['transport']);
  });

  test('cleanup is idempotent', () => {
    const { cleanup, events } = makeHarness();
    cleanup.commit();

    cleanup.close();
    cleanup.close();

    expect(events).toEqual(['terminals', 'transport', 'fingerprint']);
  });
});
