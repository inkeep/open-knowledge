import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { useRelaunchInFlight } from '@/lib/relaunch-store';
import { restartCollabServer } from '@/lib/restart-collab-server';
import type { SyncStatus } from './use-sync-status';

const TOAST_ID = 'sync-status';

/**
 * How long a disconnect may persist before we treat the server as *stopped*
 * (not a transient blip) and downgrade the toast copy. A network hiccup or
 * transient socket drop reconnects well under this and the `connected`/`synced`
 * branches cancel the downgrade; a server whose process actually stopped never
 * reconnects, so after the grace the optimistic "your edits will sync when
 * reconnected" promise (a dead end once the process is gone) is replaced with
 * an honest "server stopped" message. The grace is a wall-clock measure of the
 * whole outage, not of time on the current document (see
 * `disconnectedSinceRef` for the hop semantics).
 *
 * Sleep/wake is the one case a `setTimeout` grace cannot time correctly: the
 * timer is suspended with the process, so on wake it can fire (elapsed wall
 * time > grace) before the socket has re-established, briefly showing the
 * terminal copy for a healthy server. Self-correcting — the `connected` hop
 * replaces the false claim and `synced` shows "Reconnected" moments later.
 *
 * Deliberately shorter than the app's 30s "give up" thresholds (e.g. the
 * sync-timeout deadline): this is only a COPY downgrade, not an abandonment —
 * the toast and its Restart button stay up, and nothing stops trying to
 * reconnect. 10s is long enough to ride out an ordinary blip and short enough
 * that a genuinely dead server does not sit under a false "will sync" promise.
 */
const DISCONNECT_PRESUMED_DEAD_MS = 10_000;

/**
 * onClick for the disconnect toast's "Restart server" action. When a project's
 * server has actually stopped (`ok stop`, an idle-shutdown that fired while the
 * window was open), reconnecting never succeeds — there is no server to reach.
 * Restarting spawns a fresh one. Exported for unit tests. On a resolved failure
 * the warning is swapped for an error; on success main tears the window down so
 * nothing else runs.
 */
export async function runDisconnectRestart(
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>,
): Promise<void> {
  try {
    const result = await restartCollabServer(bridge);
    if (!result.ok) {
      toast.error(result.message, { id: TOAST_ID, duration: Infinity });
    }
  } catch {
    // The restart invoke rejects when main destroys this window mid-call (the
    // success path). The window is going away — nothing to do.
  }
}

/**
 * Fires toasts on sync-status transitions: warning on disconnect, success on reconnect.
 * Silent on the happy path (connecting → connected → synced).
 */
export function useSyncToasts(status: SyncStatus, activeDocName: string | null) {
  const { t } = useLingui();
  // A desktop auto-update relaunch tears the server down on purpose, and the
  // file sidebar already shows a calm "Relaunching…" notice — so suppress the
  // alarming infinite "Connection lost" warning during one, or the two surfaces
  // contradict each other. Kept as an effect dep so that if the relaunch aborts
  // while still disconnected, this re-runs and the warning fires for the
  // now-genuine outage.
  const relaunchInFlight = useRelaunchInFlight();
  const hasConnectedRef = useRef(false);
  const wasDisconnectedRef = useRef(false);
  // Pending grace timer that downgrades the optimistic toast to the honest
  // "server stopped" copy, plus a sticky flag so once we've downgraded a
  // re-render while still disconnected does not revert to the optimistic copy.
  const downgradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downgradedRef = useRef(false);
  // True from the first outage toast until a dismiss or "Reconnected" clears
  // it (set by every emitter at `showToast`). The `connected` branch keys its
  // replace on this — an outage claim of EITHER kind is falsified by a live
  // socket, so the accurate connected-but-stalled copy must take over whether
  // the standing toast was the optimistic one (sub-grace reconnect) or the
  // terminal one (post-grace). Not a strict "an outage toast is on screen"
  // invariant: `runDisconnectRestart`'s failed-restart branch overwrites the
  // same TOAST_ID slot with an error toast without clearing this, so it can
  // read true while that error is what's showing. Deliberate — a live socket
  // obsoletes a restart-failure headline too.
  //
  // Outage state is server-scoped — each doc holds its own provider, but a
  // real server outage drops every socket together — so no outage STATE
  // resets when `activeDocName` changes: the refs, the terminal
  // `downgradedRef` claim, the outage clock, and the standing toast all carry
  // (the timer OBJECT alone is doc-scoped — see the doc-less branch). While a
  // claim stands, whichever branch next runs re-asserts, replaces, or
  // resolves it — a dead server never wins its "will sync when reconnected"
  // promise back just because the user tried a different file. With no claim
  // standing, a doc change touches nothing: the slot then holds either a
  // self-expiring "Reconnected" or a restart-failure error the user still
  // needs, and neither should vanish because a tab changed.
  const outageToastStandingRef = useRef(false);
  // Wall-clock stamp of when the current outage's grace first armed — the
  // canonical statement of the hop semantics. The grace measures TOTAL time
  // across the outage, not time on the current document: a hop through a
  // non-document tab cancels the timer object (nothing doc-less could follow
  // it up) but keeps this stamp, so a document reopen re-arms with the
  // REMAINDER — or downgrades on the spot if the deadline passed during the
  // hop. Alternating between an editor pane and an image pane can therefore
  // neither fire a toast doc-less nor starve the downgrade by resetting the
  // clock. Set when the grace first arms; stays set after the downgrade fires
  // (the outage is still live); cleared only where the outage claim itself
  // resolves: a live socket (`connected`/`synced`) or the relaunch guard.
  // Wall-clock (`Date.now()`) over a monotonic clock is deliberate:
  // `setTimeout` is itself suspended with the process, so the sleep/wake
  // reasoning on `DISCONNECT_PRESUMED_DEAD_MS` is wall-clock either way. A
  // backwards clock step (NTP correction) between arm and re-arm is bounded
  // by the re-arm's upper clamp to at most one fresh grace.
  const disconnectedSinceRef = useRef<number | null>(null);

  // Clear the grace timer on unmount only. Empty deps so it does NOT run on
  // every status flip — the timer must survive the connecting/disconnected
  // churn of a reconnect loop to actually reach the grace. Refs are stable, so
  // no dependency is needed.
  useEffect(
    () => () => {
      if (downgradeTimerRef.current !== null) {
        clearTimeout(downgradeTimerRef.current);
        downgradeTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const clearDowngradeTimer = () => {
      if (downgradeTimerRef.current !== null) {
        clearTimeout(downgradeTimerRef.current);
        downgradeTimerRef.current = null;
      }
    };

    if (status === 'synced') {
      hasConnectedRef.current = true;
    }

    // Relaunch suppression, above BOTH the doc-less return and every toast
    // emitter, so "this hook is silent during a relaunch" holds on every path
    // — including a flag flip that lands while a non-document tab is focused
    // with a claim standing (the guard reads no document context, so there is
    // no reason to let the doc-less return shadow it). An outage toast (with
    // a live Restart button aimed at a server the updater is sweeping) would
    // contradict the sidebar's calm "Relaunching…" notice (rationale at
    // `relaunchInFlight` above). `hasConnectedRef` is recorded above this
    // guard so an aborted relaunch at `synced` still knows the window once
    // connected;
    // `wasDisconnectedRef` is left untouched, so an aborted relaunch that
    // later syncs shows "Reconnected" only if a real outage preceded it.
    if (relaunchInFlight) {
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      toast.dismiss(TOAST_ID);
      outageToastStandingRef.current = false;
      return;
    }

    if (!activeDocName) {
      // The focused tab is not a DOCUMENT — an image/PDF, a folder listing,
      // the skills browser, an over-limit file, a blank tab, or no pane target
      // at all. That is ordinary navigation, not teardown: the standing outage
      // claim and its Restart button stay up (they are the only post-sync
      // outage surface), and `downgradedRef` + the outage clock survive. A
      // document reopen then resumes on the ORIGINAL deadline: mid-grace it
      // re-shows the optimistic copy for the remainder only; once the grace is
      // spent (downgraded before the hop, or elapsed during it) it shows the
      // honest copy immediately. What can never happen is a fresh 10s promise
      // against a server already silent that long. Only the timer OBJECT is
      // cancelled: no branch below runs while doc-less, so a timer firing here
      // could neither be cancelled by the reconnect it raced nor followed by
      // the replace/resolve arms — the reopen re-arms from the surviving stamp
      // (see `disconnectedSinceRef`). Accepted residual: nothing can falsify a
      // claim while doc-less either, so if the server recovers during the hop
      // the claim stands stale until a document regains focus (same staleness
      // already accepted at `connecting`; a doc-independent health signal
      // would be a design change, not a gap here).
      clearDowngradeTimer();
      return;
    }

    // Desktop only: offer a working recovery on the outage toasts. Both desktop
    // server kinds restart from here: a project server via
    // `restartAttachedServer`, and an ephemeral single-file server via the
    // sender-routed `restartEphemeralServer` (the `ok:project:restart-server` IPC
    // picks the path from the requesting window), so single-file is not gated
    // off. In `ok ui` (browser) mode there is no bridge, so the toasts stay
    // message-only. (No `typeof window` guard — this runs inside useEffect,
    // always client-side.)
    const bridge = window.okDesktop;
    const hasRestartButton = bridge !== undefined;
    const restartAction =
      bridge !== undefined
        ? {
            action: {
              label: t`Restart server`,
              onClick: () => {
                void runDisconnectRestart(bridge);
              },
            },
          }
        : {};
    // The three outage messages, each factored once so the copy and its options
    // cannot drift between call sites (all share TOAST_ID, so the latest call
    // replaces the previous message in place; each records itself standing):
    // - optimistic: a fresh disconnect — reconnect + delivery are expected.
    // - connected-but-stalled: the socket is proven live but edits are not
    //   landing — replaces whichever outage claim a live socket falsified.
    //   Names delivery rather than sync: "Sync" is the Git-integration label
    //   elsewhere in the product (`SyncStatusBadge`, settings `SyncSection`),
    //   so a bare "not syncing" status claim reads as a Git problem. The
    //   optimistic copy below predates this and still says "will sync".
    // - terminal: the grace elapsed with no reconnect — the server is presumed
    //   stopped. Only browser (`ok ui`) mode has no Restart button; there the
    //   copy omits the restart instruction so it never points at an absent
    //   control.
    const showToast = (message: string) => {
      outageToastStandingRef.current = true;
      toast.warning(message, { id: TOAST_ID, duration: Infinity, ...restartAction });
    };
    const showConnectionLost = () =>
      showToast(t`Connection lost — keep this tab open, your edits will sync when reconnected`);
    const showConnectedStalled = () =>
      showToast(
        hasRestartButton
          ? t`Connected, but your edits aren't reaching the server yet. Restart it if this continues.`
          : t`Connected, but your edits aren't reaching the server yet.`,
      );
    const showServerStopped = () =>
      showToast(
        hasRestartButton ? t`The server stopped. Restart it to reconnect.` : t`The server stopped.`,
      );

    if (status === 'connected') {
      // The socket reopened, so the server is reachable — a stopped server never
      // reaches `connected` (its process is gone, the connection is refused).
      // Cancel a pending downgrade so the grace can't fire "The server stopped."
      // over a live socket, and drop the sticky flag so a later re-disconnect
      // arms a fresh grace. A live socket falsifies WHICHEVER claim is standing
      // — "Connection lost", "The server stopped.", or a stranded
      // restart-failure error (see `outageToastStandingRef`'s docblock) — so if
      // one is up, REPLACE it (same toast id) with copy that names this exact
      // state, keeping the Restart button: a socket that parks here without
      // ever syncing (auth stall, wedged doc) gets no further transition to
      // hand it one, whether it reopened before the grace or after. On the
      // common recovery path `synced` lands moments later and swaps in
      // "Reconnected"; the brief accurate intermediate is the cost of never
      // showing a falsified headline.
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      if (outageToastStandingRef.current) showConnectedStalled();
    }

    if (status === 'disconnected' && hasConnectedRef.current) {
      wasDisconnectedRef.current = true;
      // The action rides BOTH the optimistic and the terminal toast. A
      // reconnected socket that never re-syncs, or one that flaps faster than
      // the grace, never reaches the terminal downgrade (the `connected` hop
      // cancels it), so the optimistic toast is the only surface left to carry
      // recovery. (A server that never syncs on FIRST connect is not this hook's
      // case — `hasConnectedRef` gates on a prior `synced`, and the sync-timeout
      // error boundary owns that persona with its own Restart action.)
      if (downgradedRef.current) {
        // Already presumed stopped — keep the honest message across re-renders.
        showServerStopped();
        return;
      }
      // Arm the downgrade for the REMAINDER of the grace — the clock survives
      // non-document hops (see `disconnectedSinceRef`), so tab alternation
      // cannot renew the optimistic promise. A transient disconnect reconnects
      // under the grace and the `connected`/`synced` branches cancel this; a
      // stopped server never reconnects, so at the deadline we swap in the
      // honest copy. A grace already spent (the deadline passed while no
      // document was focused) downgrades right here, synchronously — a
      // zero-delay timer would only write the optimistic copy over the honest
      // one for a tick.
      if (downgradeTimerRef.current === null) {
        const now = Date.now();
        if (disconnectedSinceRef.current === null) {
          disconnectedSinceRef.current = now;
        }
        // Clamped above by the full grace so a backwards wall-clock step
        // (NTP correction between arm and re-arm) stretches the wait by at
        // most one fresh grace instead of the size of the step.
        const remainingMs = Math.min(
          DISCONNECT_PRESUMED_DEAD_MS,
          DISCONNECT_PRESUMED_DEAD_MS - (now - disconnectedSinceRef.current),
        );
        if (remainingMs <= 0) {
          downgradedRef.current = true;
          showServerStopped();
          return;
        }
        downgradeTimerRef.current = setTimeout(() => {
          downgradeTimerRef.current = null;
          downgradedRef.current = true;
          showServerStopped();
        }, remainingMs);
      }
      showConnectionLost();
    } else if (wasDisconnectedRef.current && status === 'synced') {
      wasDisconnectedRef.current = false;
      clearDowngradeTimer();
      downgradedRef.current = false;
      disconnectedSinceRef.current = null;
      // The outage is over — the success replaces the outage toast in place
      // (same id) and auto-expires, so no outage toast is standing anymore.
      outageToastStandingRef.current = false;
      toast.success(t`Reconnected`, { id: TOAST_ID, duration: 3000 });
    }
  }, [status, activeDocName, t, relaunchInFlight]);
}
