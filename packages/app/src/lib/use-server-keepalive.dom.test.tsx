/**
 * RTL mount tests for `useServerKeepalive` — start-once lifecycle,
 * presence-invisible options, the Electron gate, latest-collabUrl resolution
 * without socket churn, and teardown on unmount. Invoked via `bun run test:dom`
 * (jsdom substrate, precedent #43). Behavior-only per AGENTS.md React-test
 * discipline: we assert what the hook does (start/skip/close, resolver output),
 * never its source text.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { KeepaliveHandle, KeepaliveOptions } from '@inkeep/open-knowledge-core/keepalive';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { type UseServerKeepaliveOptions, useServerKeepalive } from './use-server-keepalive';

const ASYNC_EFFECT_TIMEOUT_MS = 1000;

interface FakeKeepalive {
  start: (opts: KeepaliveOptions) => KeepaliveHandle;
  readonly calls: ReadonlyArray<KeepaliveOptions>;
  closeCount: () => number;
}

function makeFakeKeepalive(): FakeKeepalive {
  const calls: KeepaliveOptions[] = [];
  let closed = 0;
  const handle: KeepaliveHandle = {
    close: () => {
      closed += 1;
    },
    isConnected: () => false,
  };
  return {
    start: (opts: KeepaliveOptions) => {
      calls.push(opts);
      return handle;
    },
    calls,
    closeCount: () => closed,
  };
}

function HookProbe({
  collabUrl,
  options,
}: {
  collabUrl: string | null;
  options?: UseServerKeepaliveOptions;
}) {
  useServerKeepalive(collabUrl, options);
  return <div data-testid="keepalive-probe" />;
}

describe('useServerKeepalive (Tier-3 mount)', () => {
  afterEach(() => {
    cleanup();
  });

  test('starts a single presence-invisible keepalive on mount (non-desktop)', async () => {
    const fake = makeFakeKeepalive();
    render(
      <HookProbe
        collabUrl="ws://localhost:5173/collab"
        options={{ startKeepalive: fake.start, isElectronHost: () => false }}
      />,
    );

    await waitFor(
      () => {
        expect(fake.calls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );

    const opts = fake.calls[0];
    // Presence-invisible: no identity triplet, no connectionId, no pid.
    expect(opts.connectionId).toBeUndefined();
    expect(opts.displayName).toBeUndefined();
    expect(opts.clientName).toBeUndefined();
    expect(opts.colorSeed).toBeUndefined();
    expect(opts.pid).toBeUndefined();
    // Resolver strips the trailing /collab so the primitive appends cleanly.
    expect(await opts.resolveWsUrl()).toBe('ws://localhost:5173');
  });

  test('resolver yields undefined while collabUrl is unresolved (primitive backs off)', async () => {
    const fake = makeFakeKeepalive();
    render(
      <HookProbe
        collabUrl={null}
        options={{ startKeepalive: fake.start, isElectronHost: () => false }}
      />,
    );

    await waitFor(
      () => {
        expect(fake.calls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(await fake.calls[0].resolveWsUrl()).toBeUndefined();
  });

  test('skips the keepalive entirely inside an Electron host', async () => {
    const fake = makeFakeKeepalive();
    render(
      <HookProbe
        collabUrl="ws://localhost:5173/collab"
        options={{ startKeepalive: fake.start, isElectronHost: () => true }}
      />,
    );

    // Give the mount effect a chance to (not) run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.calls.length).toBe(0);
  });

  test('does not restart on collabUrl change — resolver reads the latest value', async () => {
    const fake = makeFakeKeepalive();
    const options = { startKeepalive: fake.start, isElectronHost: () => false };
    const { rerender } = render(
      <HookProbe collabUrl="ws://localhost:1111/collab" options={options} />,
    );

    await waitFor(
      () => {
        expect(fake.calls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(await fake.calls[0].resolveWsUrl()).toBe('ws://localhost:1111');

    // Simulate a server respawn on a new port: collabUrl re-resolves.
    rerender(<HookProbe collabUrl="ws://localhost:2222/collab" options={options} />);
    await act(async () => {
      await Promise.resolve();
    });

    // No socket churn: still exactly one keepalive, now resolving the new port.
    expect(fake.calls.length).toBe(1);
    expect(await fake.calls[0].resolveWsUrl()).toBe('ws://localhost:2222');
  });

  test('closes the keepalive on unmount', async () => {
    const fake = makeFakeKeepalive();
    const { unmount } = render(
      <HookProbe
        collabUrl="ws://localhost:5173/collab"
        options={{ startKeepalive: fake.start, isElectronHost: () => false }}
      />,
    );

    await waitFor(
      () => {
        expect(fake.calls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );

    unmount();
    expect(fake.closeCount()).toBe(1);
  });
});
