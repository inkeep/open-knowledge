/**
 * RTL mount tests pinning CloneDialog's first paint to the shared
 * auth-state cache. This is the consumer half of the disconnect-revert
 * behavior: Settings → Account writes the cache on disconnect, and the Clone
 * dialog reads it here on its next open — so a signed-in combobox reverts to
 * the plain URL input without a relaunch. Status is held pending so the assertion
 * is on the cache-seeded first frame, not a resolved re-check.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { getLastKnownSignedIn, setLastKnownSignedIn } from '@/lib/auth-state-cache';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import { CloneDialog } from './CloneDialog';

// CloneDialog mounts a Radix Dialog (focus-trap), which reaches for DOM globals
// `tests/dom/jsdom-preload.ts` does not expose. Hoist the needed shims locally —
// same pattern as `AccountSection.dom.test.tsx` / `SettingsDialogShell.dom.test.tsx`.
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

// Status/repos stay pending so the rendered branch is the one seeded from the
// shared cache, never a resolved on-open re-check.
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
    // null is the dominant session-fresh first-open path. It must render the
    // repo-browser combobox (optimistic signed-in), not the plain input — else a
    // signed-in user sees a "Connect GitHub" flash before the status resolves.
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

    // The on-open check throws, so the dialog falls back to the plain URL input
    // for this render...
    await screen.findByText('Browse your repos:');
    // ...but a thrown (unreachable) check is not a confirmed sign-out. The
    // shared cache that Settings → Account also writes/reads must stay
    // untouched, so a transient failure here can't wrongly revert other
    // surfaces. Only a resolved status (signed in / out) updates the cache.
    expect(getLastKnownSignedIn()).toBe(true);
  });
});
