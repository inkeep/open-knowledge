
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { getLastKnownSignedIn, setLastKnownSignedIn } from '@/lib/auth-state-cache';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import { CloneDialog } from './CloneDialog';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const pendingQueryTransport: AuthQueryTransport = {
  status: () => new Promise(() => {}),
  repos: () => new Promise(() => {}),
  signout: async () => ({ ok: true }),
};

function renderCloneDialog() {
  return render(
    <CloneDialog open onOpenChange={() => {}} authQueryTransport={pendingQueryTransport} />,
  );
}

describe('CloneDialog first paint from the shared auth-state cache', () => {
  beforeEach(() => setLastKnownSignedIn(null));
  afterEach(() => {
    cleanup();
    setLastKnownSignedIn(null);
  });

  test('seeds the repo-browser combobox when the cache says signed in', () => {
    setLastKnownSignedIn(true);

    renderCloneDialog();

    expect(screen.getByRole('combobox')).toBeDefined();
  });

  test('treats a never-checked (null) cache as signed in — no Connect flash on first open', () => {
    setLastKnownSignedIn(null);

    renderCloneDialog();

    expect(screen.getByRole('combobox')).toBeDefined();
    expect(screen.queryByText('Browse your repos:')).toBeNull();
  });

  test('reverts to the plain URL input when the cache says signed out', () => {
    setLastKnownSignedIn(false);

    renderCloneDialog();

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Browse your repos:')).toBeDefined();
  });

  test('a thrown on-open status check leaves the shared cache untouched', async () => {
    setLastKnownSignedIn(true);
    const throwingQueryTransport: AuthQueryTransport = {
      status: async () => {
        throw new Error('relay unreachable');
      },
      repos: () => new Promise(() => {}),
      signout: async () => ({ ok: true }),
    };

    render(
      <CloneDialog open onOpenChange={() => {}} authQueryTransport={throwingQueryTransport} />,
    );

    await screen.findByText('Browse your repos:');
    expect(getLastKnownSignedIn()).toBe(true);
  });
});
