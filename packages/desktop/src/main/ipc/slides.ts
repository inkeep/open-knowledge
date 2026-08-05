/**
 * IPC handler implementations for the Slides (Slidev) surface.
 *
 * Single channel `ok:slides:dispatch` with discriminated args:
 *   - `status` — pure read; whether a runnable `slidev` resolved for the
 *                window's project and from where (project-local vs global).
 *   - `open`   — start a `slidev` server for a deck, confirm it serves, and open
 *                it in a dedicated window; a deck already open focuses its
 *                window instead of spawning again.
 *
 * Project scoping: each editor window has one bound project via the
 * window-manager context. The renderer never passes a project; main looks it up
 * from `event.sender`. For `open`, main also validates the deck path is absolute
 * and inside that project before it reaches here.
 *
 * Electron-free and dependency-injected (resolution probes, the start deps, and
 * the deck registry are passed in) so this unit-tests without an Electron
 * runtime; `main/index.ts` wires the real ones.
 */

import type { OkSlidesOpenResult, OkSlidesStatusResult } from '../../shared/ipc-channels.ts';
import type { SlidesDeckRegistry, SlidesDeckWindow } from '../slides-registry.ts';
import { resolveSlidev, type SlidevResolveProbes } from '../slidev-resolve.ts';
import { type SlidevProcess, type StartSlidevDeps, startSlidevServer } from '../slidev-server.ts';

/**
 * Pure read — never throws (the injected probes report absence rather than
 * erroring). Safe to invoke from a mount effect: it performs at most one fs
 * stat plus one login-shell probe, and reports `available: false` when neither
 * a project-local nor a global `slidev` resolves.
 */
export async function handleSlidesStatus(
  projectRoot: string | undefined,
  probes: SlidevResolveProbes,
): Promise<OkSlidesStatusResult> {
  const resolution = await resolveSlidev(projectRoot, probes);
  return resolution.available
    ? { kind: 'status', available: true, source: resolution.source }
    : { kind: 'status', available: false };
}

export interface SlidesOpenDeps {
  /** App-wide deck registry — read for the one-deck dedup (focus-existing), and
   *  for the in-flight marker that dedups activations arriving before the first
   *  one has finished starting its server. */
  registry: Pick<
    SlidesDeckRegistry,
    | 'get'
    | 'getOpenInFlight'
    | 'setOpenInFlight'
    | 'clearOpenInFlight'
    | 'trackSpawned'
    | 'untrackSpawned'
  >;
  /** Injected deps for {@link startSlidevServer} (spawn, free port, probe, clock). */
  startDeps: StartSlidevDeps;
  /** Open a confirmed-ready deck in its window. The window factory records the
   *  deck and wires its close-time reap, so this returns nothing. Injected so
   *  the orchestration unit-tests without an Electron runtime. */
  openWindow(deck: { docPath: string; port: number; process: SlidevProcess }): void;
  /** Raise an already-open deck's window to the foreground. */
  focusWindow(window: SlidesDeckWindow): void;
  /** Record one genuine deck-open attempt — a spawn was actually tried. Fired
   *  exactly once per attempt from inside the in-flight promise, so it never
   *  double-counts a joined activation and never fires for a focus-existing
   *  reopen (neither spawns). Injected so this module stays Electron- and
   *  telemetry-free; `main/index.ts` wires it to `recordDeckOpen`. Required (not
   *  optional) so a future refactor that drops the wiring fails to compile rather
   *  than silently stopping the adoption/failure signal. */
  recordOpenAttempt(result: OkSlidesOpenResult): void;
}

/**
 * Open the deck at `docPath` as slides. `docPath` is already validated absolute +
 * project-contained by the caller. A deck already open focuses its existing
 * window (one deck, one server, one window); otherwise a server is started and,
 * only once it is confirmed serving, opened in a window. The four start/readiness
 * failure reasons flow straight from {@link startSlidevServer}; the caller adds
 * `not-available` / `invalid-path`.
 *
 * The one-deck guarantee spans two windows of time, so it takes two checks. A
 * deck that finished opening is in the registry and is focused. A deck still
 * starting is not — registration only happens once its server is confirmed
 * serving, seconds after a cold Slidev start begins — so a second activation in
 * that gap (a double-click on the toolbar action) joins the in-flight attempt
 * and returns its real verdict, rather than starting a rival server whose window
 * would then overwrite the first's registry entry.
 */
export async function handleSlidesOpen(
  docPath: string,
  deps: SlidesOpenDeps,
): Promise<OkSlidesOpenResult> {
  const existing = deps.registry.get(docPath);
  if (existing !== undefined) {
    deps.focusWindow(existing.window);
    return { kind: 'open', ok: true };
  }
  const inFlight = deps.registry.getOpenInFlight(docPath);
  if (inFlight !== undefined) return inFlight;

  const attempt = (async (): Promise<OkSlidesOpenResult> => {
    const started = await startSlidevServer({
      ...deps.startDeps,
      // Reachable by app-quit teardown from the instant of spawn, not from the
      // instant of success — the readiness poll in between takes seconds on a
      // cold Vite start, and a quit landing there would otherwise strand a
      // `detached` process holding its port.
      onSpawned: (process) => deps.registry.trackSpawned(docPath, process),
    });
    if (!started.ok) {
      deps.registry.untrackSpawned(docPath);
      const result: OkSlidesOpenResult = { kind: 'open', ok: false, reason: started.reason };
      deps.recordOpenAttempt(result);
      return result;
    }
    try {
      deps.openWindow({ docPath, port: started.port, process: started.process });
    } catch (err) {
      // The server is confirmed serving but never made it into `decks`, so
      // nothing downstream would ever reap it. Signal before rethrowing.
      started.process.signal('SIGTERM');
      throw err;
    } finally {
      // `openWindow` registers the deck, so ownership has transferred to
      // `decks`; on the throw path the signal above already handled it.
      deps.registry.untrackSpawned(docPath);
    }
    const result: OkSlidesOpenResult = { kind: 'open', ok: true };
    deps.recordOpenAttempt(result);
    return result;
  })();
  deps.registry.setOpenInFlight(docPath, attempt);
  try {
    return await attempt;
  } finally {
    deps.registry.clearOpenInFlight(docPath);
  }
}
