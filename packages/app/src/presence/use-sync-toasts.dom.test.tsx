/**
 * Hook tests for the disconnect-toast grace downgrade: the optimistic
 * "will sync when reconnected" copy is swapped for an honest "server stopped"
 * message only after a grace with no reconnect, and a reconnect (`synced`, or a
 * bare `connected` socket) before the grace cancels the downgrade. Runs under
 * jsdom (`test:dom`) so `renderHook` works; the `t` template macro resolves to
 * its English source text (no catalog is activated, so the macro returns the
 * source string, which the assertions match). `toast` and the relaunch store are
 * mocked.
 */

import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const warning = vi.fn();
const success = vi.fn();
const dismiss = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    warning: (...args: unknown[]) => warning(...args),
    success: (...args: unknown[]) => success(...args),
    dismiss: (...args: unknown[]) => dismiss(...args),
    error: () => {},
  },
}));
// Controllable so the relaunch-suppression path is reachable (a constant-false
// mock would leave that branch untestable).
let relaunchInFlightFlag = false;
vi.mock('@/lib/relaunch-store', () => ({ useRelaunchInFlight: () => relaunchInFlightFlag }));

import { useSyncToasts } from './use-sync-toasts';

const messages = (spy: typeof warning): string[] => spy.mock.calls.map((c) => String(c[0]));

// Matches the dom tier's okDesktop stub convention (configurable
// defineProperty, reset in beforeEach) — see e.g. EditorHeader.dom.test.tsx.
function setBridge(singleFile: boolean) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: {
      config: { singleFile, projectPath: '/tmp/p' },
      restartServer: vi.fn(async () => ({ ok: true })),
    },
  });
}

// The downgraded (server-stopped) toast is the last `warning` call after the grace.
const lastWarning = () => warning.mock.calls.at(-1) as [string, { action?: unknown }] | undefined;

describe('useSyncToasts — disconnect grace downgrade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warning.mockClear();
    success.mockClear();
    dismiss.mockClear();
    relaunchInFlightFlag = false;
    Object.defineProperty(window, 'okDesktop', { configurable: true, value: undefined });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('downgrades to the honest "server stopped" copy after the grace with no reconnect', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      {
        initialProps: { s: 'synced' as const },
      },
    );

    // Disconnect after having synced → optimistic copy first.
    act(() => rerender({ s: 'disconnected' }));
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true);
    warning.mockClear();

    // No reconnect across the grace → honest terminal copy replaces it.
    act(() => vi.advanceTimersByTime(10_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('a reconnect before the grace cancels the downgrade (no "server stopped")', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      {
        initialProps: { s: 'synced' as const },
      },
    );

    act(() => rerender({ s: 'disconnected' }));
    warning.mockClear();
    act(() => rerender({ s: 'synced' }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    expect(success).toHaveBeenCalled();
  });

  test('ephemeral single-file: honest toast offers the working Restart button (sender-routed to the ephemeral respawn)', () => {
    // Restart is routed to the correct server by the requesting window
    // (`ok:project:restart-server` resolves ephemeral vs project by sender), so a
    // stopped single-file session gets a working button.
    setBridge(true);
    const restartSpy = (window as { okDesktop?: { restartServer: ReturnType<typeof vi.fn> } })
      .okDesktop?.restartServer as ReturnType<typeof vi.fn>;
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));

    const last = lastWarning();
    expect(String(last?.[0])).toMatch(/restart it to reconnect/i);
    // The terminal toast is the standing affordance for a dead server: it must
    // replace in place (same id) and never auto-expire out from under the user.
    expect(last?.[1]).toMatchObject({ id: 'sync-status', duration: Infinity });
    const action = last?.[1]?.action as { onClick: () => void } | undefined;
    expect(action).toBeDefined();
    // The button is wired to a real restart, not decorative: clicking it invokes
    // the bridge's restartServer.
    act(() => action?.onClick());
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  test('project server: honest toast offers the working Restart button', () => {
    setBridge(false);
    const restartSpy = (window as { okDesktop?: { restartServer: ReturnType<typeof vi.fn> } })
      .okDesktop?.restartServer as ReturnType<typeof vi.fn>;
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));

    const last = lastWarning();
    expect(String(last?.[0])).toMatch(/restart it to reconnect/i);
    const action = last?.[1]?.action as { onClick: () => void } | undefined;
    expect(action).toBeDefined();
    act(() => action?.onClick());
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  test('the optimistic toast carries the Restart button too (desktop, before the grace)', () => {
    // The button rides the optimistic toast, not just the terminal one — a server
    // that opens but never syncs (or flaps) never reaches the downgrade, so the
    // optimistic toast is the only surface left to carry recovery.
    setBridge(true);
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' })); // no timer advance: pre-grace
    const optimistic = warning.mock.calls.find((c) => String(c[0]).includes('keep this tab open'));
    expect(optimistic).toBeDefined();
    expect((optimistic?.[1] as { action?: unknown })?.action).toBeDefined();
    // Same single-slot contract as the terminal toast: fixed id, never expires.
    expect(optimistic?.[1]).toMatchObject({ id: 'sync-status', duration: Infinity });
  });

  test('a reconnected socket that never re-syncs (pre-grace) gets the accurate stalled copy AND its Restart button', () => {
    // Wedged-but-alive after a prior sync: the socket reopens under the grace and
    // then parks at `connected` without `synced` (auth stall / large initial sync
    // / wedged doc). The `connected` hop replaces the now-falsified "Connection
    // lost" claim with the accurate stalled copy — the SAME copy the post-grace
    // route gets, so one runtime state never reads two different messages — and
    // keeps the button. (A server that never syncs on FIRST connect is the
    // sync-timeout error boundary's persona, not this toast's.)
    setBridge(true);
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(5_000)); // under the grace
    dismiss.mockClear();
    act(() => rerender({ s: 'connected' }));
    act(() => vi.advanceTimersByTime(30_000)); // parks at connected, well past the grace

    // Replaced in place — never dismissed, never downgraded to "server stopped".
    expect(dismiss).not.toHaveBeenCalled();
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    const last = lastWarning();
    expect(String(last?.[0])).toContain("aren't reaching the server");
    expect(last?.[1]?.action).toBeDefined();
  });

  test('a socket that reopens AFTER the grace and parks at connected still has a standing toast with a Restart button', () => {
    // The post-grace variant of the wedged persona: the terminal "server stopped"
    // already fired, then the socket reopens and never re-syncs. The `connected`
    // hop must REPLACE the falsified terminal claim with the accurate stalled
    // copy + button (same toast id), never dismiss to silence — no branch
    // re-runs while the status parks at `connected`, so whatever this hop
    // leaves on screen is the persona's last word.
    setBridge(true);
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000)); // grace elapses → terminal toast fired
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'connected' }));
    act(() => vi.advanceTimersByTime(30_000)); // parks at connected

    expect(dismiss).not.toHaveBeenCalled(); // replaced, not dismissed to silence
    const last = lastWarning();
    expect(String(last?.[0])).toContain("aren't reaching the server"); // names the actual state
    expect(String(last?.[0])).toMatch(/restart it/i); // copy points at the control
    expect(last?.[1]?.action).toBeDefined(); // and it carries the Restart button
    // Full option shape: same toast id (in-place replace) and a sticky duration.
    expect(last?.[1]).toMatchObject({ id: 'sync-status', duration: Infinity });
  });

  test('a server flapping faster than the grace still carries a Restart button and never falsely reports stopped', () => {
    setBridge(true);
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    // Each disconnect re-shows the optimistic toast; each connect cancels the
    // grace, so the terminal downgrade never accumulates 10s and never fires.
    for (let i = 0; i < 4; i++) {
      act(() => rerender({ s: 'disconnected' }));
      act(() => vi.advanceTimersByTime(3_000));
      act(() => rerender({ s: 'connected' }));
      act(() => vi.advanceTimersByTime(3_000));
    }
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    const optimistics = warning.mock.calls.filter((c) =>
      String(c[0]).includes('keep this tab open'),
    );
    expect(optimistics.length).toBeGreaterThan(0);
    for (const call of optimistics) {
      expect((call[1] as { action?: unknown })?.action).toBeDefined();
    }
  });

  test('disconnected → connected → synced shows Reconnected with no false "server stopped" and no premature dismiss', () => {
    // The production reconnect ordering — a reconnect cannot skip `connected`.
    setBridge(false);
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(2_000)); // brief blip, under the grace
    dismiss.mockClear();
    act(() => rerender({ s: 'connected' }));
    // The standing "Connection lost" is replaced in place with the accurate
    // stalled intermediate — never dismissed (a dismiss-then-recreate on the
    // same id would race the exit animation).
    expect(dismiss).not.toHaveBeenCalled();
    act(() => rerender({ s: 'synced' }));
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('browser mode (no bridge): honest toast is message-only, no Restart control', () => {
    // No `window.okDesktop` (the `ok ui` browser case) → nothing to restart, so
    // the copy omits the "Restart it" instruction and offers no action.
    Object.defineProperty(window, 'okDesktop', { configurable: true, value: undefined });
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));

    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(String(last?.[0])).not.toMatch(/restart it/i);
    expect(last?.[1]?.action).toBeUndefined();
  });

  test('a bare `connected` socket before the grace cancels the downgrade (no "server stopped")', () => {
    // A dead server never reaches `connected` (connection refused), so a
    // `connected` transition proves the server is reachable — the grace timer
    // must be cancelled even though `synced` has not fired yet.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    warning.mockClear();
    act(() => rerender({ s: 'connected' }));
    act(() => vi.advanceTimersByTime(10_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('a `connected` AFTER the downgrade replaces the false "server stopped" claim (browser mode: message-only)', () => {
    // disconnected → (grace) → "server stopped" → connected. The socket is back,
    // so the terminal claim is false — it is REPLACED with the accurate stalled
    // copy under the same toast id (in browser mode with no bridge, message-only
    // and without the restart instruction), never dismissed to silence.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connected' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'connected' }));
    expect(dismiss).not.toHaveBeenCalled();
    const last = lastWarning();
    expect(String(last?.[0])).toContain("aren't reaching the server");
    expect(String(last?.[0])).not.toMatch(/restart it/i); // no absent-control pointer
    expect(last?.[1]?.action).toBeUndefined(); // no bridge → no button, but never silence
  });

  test('switching docs mid-outage carries the terminal claim over — no fresh "will sync" promise from a dead server', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    // Reach the terminal "server stopped" state on doc a.md.
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    dismiss.mockClear();
    warning.mockClear();

    // Still disconnected, user switches docs. ALL outage state is
    // connection-scoped and survives, so the same effect run re-asserts the
    // TERMINAL claim for the new doc — a dead server must never win back the
    // optimistic "your edits will sync when reconnected" promise just because
    // the user tried a different file.
    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    expect(dismiss).not.toHaveBeenCalled(); // re-asserted in place, not blanked
    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
  });

  test('switching docs as the outage ends replaces the claim with "Reconnected" — no dismiss-then-recreate', () => {
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    dismiss.mockClear();

    // Healthy switch: the new doc syncs. The standing claim is replaced in
    // place by "Reconnected" (same toast id) — because `wasDisconnectedRef`
    // survived the switch — with no dismiss racing the replacement.
    act(() => rerender({ s: 'synced', doc: 'b.md' }));
    expect(dismiss).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
  });

  test('a blip resolved by switching straight to an already-synced doc leaves no stale clock — a later outage gets a full fresh grace', () => {
    // Switching to an already-synced pooled document derives `synced` directly
    // on the provider swap, with no intervening `connected` render — so the
    // `synced` arm is the only place this path can clear the outage clock. A
    // stamp left stale here would make a later, ordinary blip compute a spent
    // grace and fire "The server stopped." over a healthy server within a
    // tick.
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' })); // T0: blip observed
    act(() => vi.advanceTimersByTime(3_000));
    act(() => rerender({ s: 'synced', doc: 'b.md' })); // direct-to-synced pooled switch
    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    act(() => vi.advanceTimersByTime(30_000)); // healthy editing, well past T0 + grace
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: 'b.md' })); // an ordinary later blip
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true);
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(9_999)); // a full fresh grace, not a spent one
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('switching docs while the reconnect loop is at `connecting` keeps the claim — a later parked connected still has toast + button', () => {
    // The reconnect loop spends most of its time at `connecting`, so a doc
    // switch is likeliest to land there. The standing claim must survive it:
    // if the socket then reaches `connected` and parks, the stalled copy (and
    // its Restart button) must take over — never a silent, claim-less park.
    setBridge(true);
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'connected' | 'disconnected'; doc: string }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000)); // terminal claim up
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'connecting', doc: 'b.md' })); // switch lands at connecting
    expect(dismiss).not.toHaveBeenCalled(); // the claim is carried, not blanked

    act(() => rerender({ s: 'connected', doc: 'b.md' }));
    act(() => vi.advanceTimersByTime(30_000)); // parks
    const last = lastWarning();
    expect(String(last?.[0])).toContain("aren't reaching the server");
    expect(last?.[1]?.action).toBeDefined();
  });

  test('focusing a non-document tab mid-grace keeps the toast and the clock — a doc reopen re-arms the REMAINDER', () => {
    // `activeDocName === null` means the FOCUSED TAB is not a document (an
    // image, a folder listing, the skills browser, a blank tab) — ordinary
    // navigation with the outage still live, NOT teardown. The standing toast
    // and its Restart button must stay up (they are the only post-sync outage
    // surface). The timer OBJECT is cancelled (nothing doc-less could follow
    // it up) but the outage clock keeps counting, so the reopen re-arms with
    // the remainder — alternating tabs can neither fire the downgrade doc-less
    // nor starve it by resetting the grace to a fresh 10s each time.
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' })); // t=0: outage observed
    act(() => vi.advanceTimersByTime(5_000)); // t=5s, mid-grace
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: null })); // user clicks an image tab
    act(() => rerender({ s: 'connecting', doc: null })); // status settles (null provider)
    expect(dismiss).not.toHaveBeenCalled(); // the standing toast stays up
    act(() => vi.advanceTimersByTime(3_000)); // t=8s, doc-less: no toast may fire here
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);

    // Back on a document mid-outage: re-asserts the optimistic copy, and the
    // grace resumes on the ORIGINAL schedule — 2s remain of the 10s, not a
    // fresh 10s (which would let tab alternation renew the promise forever).
    act(() => rerender({ s: 'disconnected', doc: 'b.md' }));
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true);
    act(() => vi.advanceTimersByTime(1_999)); // t=9.999s since the outage began
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1)); // t=10s exactly
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('a grace that elapses entirely on a non-document tab does not fire — the reopen delivers the honest copy', () => {
    // The two halves of the doc-less contract in one walk. First: the timer
    // OBJECT must be cancelled on the hop — nothing may reach the toast slot
    // while no document is focused, even when the deadline passes there.
    // Second: the clock kept counting, so the reopen sees a spent grace and
    // downgrades synchronously — the honest copy lands immediately, with no
    // optimistic replay against a server already silent past the deadline.
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' })); // t=0: outage observed
    act(() => vi.advanceTimersByTime(5_000)); // t=5s, mid-grace
    act(() => rerender({ s: 'disconnected', doc: null })); // hop to an image tab
    act(() => rerender({ s: 'connecting', doc: null }));
    dismiss.mockClear();
    warning.mockClear();

    act(() => vi.advanceTimersByTime(6_000)); // t=11s: past the deadline, still doc-less
    expect(warning).not.toHaveBeenCalled(); // nothing may fire without a document

    act(() => rerender({ s: 'disconnected', doc: 'b.md' })); // reopen after the spent grace
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
    expect(dismiss).not.toHaveBeenCalled(); // replaced in place throughout
  });

  test('focusing a non-document tab AFTER the downgrade keeps the terminal claim — a doc reopen re-asserts it, not the optimistic promise', () => {
    // The regression this pins: `downgradedRef` is connection-scoped and must
    // survive a hop through an image/folder tab, exactly like the doc→doc
    // path — a dead server must not win its "will sync when reconnected"
    // promise back because the user's route back to a document passed through
    // a non-document tab.
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000)); // full downgrade — terminal claim up
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'disconnected', doc: null }));
    act(() => rerender({ s: 'connecting', doc: null }));
    expect(dismiss).not.toHaveBeenCalled(); // the standing claim survives the hop

    act(() => rerender({ s: 'disconnected', doc: 'b.md' })); // back on a document
    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped'); // honest copy, immediately
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
  });

  test('reopening a document directly at `connected` after a non-document hop replaces the standing claim with the stalled copy', () => {
    // The claim stood the whole time (never dismissed on the hop), so the
    // `connected` branch replaces it — accurate at that instant; `synced`
    // resolves it moments later on the common path.
    setBridge(true);
    const { rerender } = renderHook(
      ({
        s,
        doc,
      }: {
        s: 'synced' | 'connecting' | 'connected' | 'disconnected';
        doc: string | null;
      }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000));
    act(() => rerender({ s: 'connecting', doc: null })); // hop through a non-document tab
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'connected', doc: 'b.md' })); // reopen lands on a live socket
    expect(dismiss).not.toHaveBeenCalled();
    const last = lastWarning();
    expect(String(last?.[0])).toContain("aren't reaching the server");
    expect(last?.[1]?.action).toBeDefined();
  });

  test('a doc reopen at `synced` after a non-document hop resolves the carried claim with "Reconnected"', () => {
    // The resolve leg of the hop matrix: a terminal claim survives the hop
    // (nothing can falsify it doc-less), and the reopen walks the real
    // recovery sequence — `connecting` (no branch runs), `connected`
    // (replaces the falsified terminal claim with the stalled copy), then
    // `synced` (resolves that with the success) — never a stranded Infinity
    // "server stopped" over a healthy server, never a dismiss racing the
    // replacement.
    const { rerender } = renderHook(
      ({
        s,
        doc,
      }: {
        s: 'synced' | 'connecting' | 'connected' | 'disconnected';
        doc: string | null;
      }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000)); // terminal claim up
    act(() => rerender({ s: 'connecting', doc: null })); // hop; server recovers meanwhile
    dismiss.mockClear();
    success.mockClear();

    act(() => rerender({ s: 'connecting', doc: 'b.md' })); // reopen walks the real sequence
    act(() => rerender({ s: 'connected', doc: 'b.md' }));
    act(() => rerender({ s: 'synced', doc: 'b.md' }));

    expect(success).toHaveBeenCalledWith('Reconnected', expect.anything());
    expect(dismiss).not.toHaveBeenCalled(); // replaced in place, never dismissed
  });

  test('a relaunch flag flip while a non-document tab is focused still silences the standing claim', () => {
    // The relaunch guard sits ABOVE the doc-less return, so "silent during a
    // relaunch" holds even when the flip lands on an image/folder tab with a
    // terminal claim (and its live Restart button, aimed at a server the
    // updater is sweeping) still on screen.
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'connecting' | 'disconnected'; doc: string | null }) =>
        useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' as string | null } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => vi.advanceTimersByTime(10_000)); // terminal claim up
    act(() => rerender({ s: 'connecting', doc: null })); // hop to a non-document tab
    dismiss.mockClear();

    relaunchInFlightFlag = true;
    act(() => rerender({ s: 'connecting', doc: null })); // flag flips while doc-less
    expect(dismiss).toHaveBeenCalledWith('sync-status');
  });

  test('switching docs right after a healthy reconnect leaves the expiring "Reconnected" toast alone', () => {
    // With no outage claim standing, a doc switch does nothing to the slot:
    // a "Reconnected" success self-expires, and a stranded restart-failure
    // error (which the user still needs) must not silently vanish.
    const { rerender } = renderHook(
      ({ s, doc }: { s: 'synced' | 'disconnected'; doc: string }) => useSyncToasts(s, doc),
      { initialProps: { s: 'synced' as const, doc: 'a.md' } },
    );
    act(() => rerender({ s: 'disconnected', doc: 'a.md' }));
    act(() => rerender({ s: 'synced', doc: 'a.md' })); // "Reconnected" fires, claim clears
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'synced', doc: 'b.md' }));
    // "Left alone" proven in full: nothing dismissed AND nothing re-emitted
    // into the slot — the success from the reconnect is the only one ever.
    expect(dismiss).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
  });

  test('a clean first connect is silent (no prior outage, no stalled toast)', () => {
    // The happy path the hook's docstring promises: connecting → connected →
    // synced with no prior outage emits nothing. Without the standing-claim
    // guard on the `connected` branch, a cold start would show a permanent
    // false "aren't reaching the server" warning that nothing ever replaces
    // (the "Reconnected" arm needs a prior disconnect).
    const { rerender } = renderHook(
      ({ s }: { s: 'connecting' | 'connected' | 'synced' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'connecting' as const } },
    );
    act(() => rerender({ s: 'connected' })); // first-ever connect, nothing disconnected before it
    expect(warning).not.toHaveBeenCalled();
    act(() => rerender({ s: 'synced' }));
    expect(warning).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled(); // and no "Reconnected" for an outage that never happened
  });

  test('the grace survives a disconnected→connecting churn cycle (timer is not per-branch)', () => {
    // `connecting` runs NO branch in this hook — the reconnect loop spends most
    // of its time there. The grace armed on the first disconnect must keep
    // running across those hops (the unmount-only cleanup exists precisely so
    // status churn cannot clear it), reaching the terminal copy on schedule.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'connecting' })); // no branch runs; timer keeps counting
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(2_000)); // 10s cumulative across the churn

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('after the downgrade, a connecting→disconnected churn re-asserts the terminal copy, not the optimistic one', () => {
    // The sticky `downgradedRef`: once the server is presumed stopped, status
    // churn that revisits `disconnected` must keep the honest message rather
    // than reverting to the optimistic promise.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000));
    warning.mockClear();

    act(() => rerender({ s: 'connecting' }));
    act(() => rerender({ s: 'disconnected' }));

    const last = lastWarning();
    expect(String(last?.[0])).toContain('server stopped');
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(false);
  });

  test('the grace boundary is exact: no downgrade at 9,999ms, downgrade at 10,000ms', () => {
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(9_999));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('unmounting mid-grace cancels the pending downgrade (no toast from a dead hook)', () => {
    const { rerender, unmount } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(5_000));
    unmount();
    act(() => vi.advanceTimersByTime(10_000));

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('a relaunch mid-outage silences the hook: standing toast dismissed, grace cancelled, connected re-issues nothing', () => {
    // "Silent during a relaunch" holds by construction — the suppression is
    // hoisted above every emitter, so it also covers the post-downgrade
    // `connected` replace path and a flag flip that lands while the reconnect
    // loop parks at `connecting`.
    setBridge(false);
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'connected' | 'disconnected' }) =>
        useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(10_000)); // terminal toast up
    relaunchInFlightFlag = true;
    dismiss.mockClear();
    warning.mockClear();

    act(() => rerender({ s: 'connecting' })); // flag flip lands at connecting
    expect(dismiss).toHaveBeenCalledWith('sync-status');

    act(() => rerender({ s: 'connected' })); // server back while flag still set
    act(() => vi.advanceTimersByTime(30_000));
    expect(warning).not.toHaveBeenCalled(); // no re-issue on top of the relaunch notice
  });

  test('a relaunch flag flip mid-grace cancels the pending downgrade (not just the standing toast)', () => {
    // The guard's clearDowngradeTimer must fire while a grace is actually
    // pending — a suppressed teardown must not later produce a false
    // "server stopped" from a timer armed before the flag flipped.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' }));
    act(() => vi.advanceTimersByTime(5_000)); // mid-grace
    relaunchInFlightFlag = true;
    warning.mockClear();

    act(() => rerender({ s: 'connecting' })); // flag flip lands mid-grace
    act(() => vi.advanceTimersByTime(30_000)); // well past where the grace would fire

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });

  test('an aborted relaunch re-asserts the now-genuine outage (relaunchInFlight is a live dep)', () => {
    // The docblock's promise: "if the relaunch aborts while still disconnected,
    // this re-runs and the warning fires for the now-genuine outage." The flag
    // flips true → false with the STATUS unchanged, so only the dep in the
    // effect array can re-run the hook — dropping it ships a user disconnected
    // from a torn-down server with no toast and no Restart button.
    setBridge(false);
    relaunchInFlightFlag = true;
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' })); // suppressed
    expect(warning).not.toHaveBeenCalled();

    relaunchInFlightFlag = false; // relaunch aborts; status unchanged
    act(() => rerender({ s: 'disconnected' }));
    const last = lastWarning();
    expect(String(last?.[0])).toContain('keep this tab open');
    expect(last?.[1]?.action).toBeDefined(); // and the Restart button is back
  });

  test('a relaunch that interrupts a mid-grace outage resets the clock — the post-abort outage gets a full fresh grace', () => {
    // The relaunch guard clears the outage clock along with the claim: the
    // teardown it suppresses is intentional, so time accrued before (and
    // during) the relaunch must not count against the NEXT outage. A stamp
    // left stale here would make the aborted relaunch's re-assert compute a
    // spent grace and jump straight to the terminal copy instead of the
    // optimistic one.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' })); // t=0: genuine outage, grace arms
    act(() => vi.advanceTimersByTime(5_000)); // mid-grace
    relaunchInFlightFlag = true;
    act(() => rerender({ s: 'disconnected' })); // guard silences + resets the outage state
    act(() => vi.advanceTimersByTime(30_000)); // a long relaunch
    warning.mockClear();

    relaunchInFlightFlag = false; // relaunch aborts; still disconnected
    act(() => rerender({ s: 'disconnected' }));
    expect(messages(warning).some((m) => m.includes('keep this tab open'))).toBe(true); // optimistic, not terminal
    act(() => vi.advanceTimersByTime(9_999)); // a full fresh grace for the new outage
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(true);
  });

  test('a clean relaunch leaves no outage residue: no spurious "Reconnected" after it completes', () => {
    // The suppressed disconnect must not set wasDisconnectedRef — otherwise the
    // post-relaunch sync would announce a reconnection for an outage the user
    // never saw.
    relaunchInFlightFlag = true;
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'disconnected' }) => useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' })); // the intentional teardown, suppressed
    relaunchInFlightFlag = false;
    success.mockClear();
    act(() => rerender({ s: 'synced' })); // fresh server back up

    expect(success).not.toHaveBeenCalled();
  });

  test('churn cannot orphan a second grace timer — cancel kills the ONLY pending downgrade', () => {
    // If a re-entry into `disconnected` armed a SECOND timer (instead of the
    // arm-once guard keeping the original), the `connected` cancel would clear
    // only the tracked one and the orphan would later fire a false
    // "server stopped" over a live socket.
    const { rerender } = renderHook(
      ({ s }: { s: 'synced' | 'connecting' | 'connected' | 'disconnected' }) =>
        useSyncToasts(s, 'doc.md'),
      { initialProps: { s: 'synced' as const } },
    );
    act(() => rerender({ s: 'disconnected' })); // t=0: arms the grace
    act(() => vi.advanceTimersByTime(4_000));
    act(() => rerender({ s: 'connecting' }));
    act(() => rerender({ s: 'disconnected' })); // re-entry must NOT arm a second timer
    act(() => vi.advanceTimersByTime(4_000)); // t=8s
    act(() => rerender({ s: 'connected' })); // cancels the (single) pending grace
    act(() => vi.advanceTimersByTime(30_000)); // any orphan would fire in here

    expect(messages(warning).some((m) => m.includes('server stopped'))).toBe(false);
  });
});
