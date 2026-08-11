/**
 * Renderer crash recovery.
 *
 * When Chromium tears down a renderer process, the BrowserWindow it backed
 * keeps its frame but paints nothing. Electron does not re-create the renderer
 * on its own, so without this module a dead renderer leaves a window that is
 * blank forever and offers the user no way to understand or undo it — the only
 * escape is knowing that Cmd-R happens to work.
 *
 * The policy is one silent auto-reload per loop window, bounded by a lifetime
 * cap. A one-off renderer death is overwhelmingly transient, and reloading
 * restores the window before the user has to think about it. A renderer that
 * dies again inside the same window is a crash loop: reloading it a second time
 * would thrash, so recovery stops and hands the user an explicit choice. The
 * lifetime cap closes the gap the per-window budget alone leaves open — a
 * renderer that dies just outside the window every time would otherwise earn a
 * fresh budget forever and reload silently without end.
 *
 * Deliberately Electron-free and window-blind in the same spirit as
 * `crash-detection.ts` — that module decides whether to invite a bug report and
 * must not grow a dependency on window lifecycles. This one owns the opposite
 * half (what happens to the window) and takes its Electron surfaces as injected
 * deps, so the policy is unit-testable against fakes.
 */

/**
 * Every reason Electron can report for `render-process-gone`, declared locally
 * rather than imported so this module stays Electron-free. Spelling the union
 * out (instead of widening to `string`) makes an Electron upgrade that adds a
 * reason fail to compile at the wiring site, which forces a deliberate
 * recoverable-or-not decision rather than letting a new reason silently fall
 * through to "do nothing".
 */
type RenderProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

/**
 * Structural subset of Electron's `WebContents`. Only the members recovery
 * needs, so tests can fake it without an Electron import and so this never has
 * to widen `BrowserWindowLike` (whose `webContents` shape is shared with every
 * window-manager test fake).
 */
export interface RecoverableWebContents {
  /** Electron's `WebContents.id`. Stamped on every log line so concurrent
   * crashes in a multi-window session can be told apart. */
  readonly id: number;
  reload(): void;
  isDestroyed(): boolean;
}

/** Structural subset of Electron's `RenderProcessGoneDetails`. */
export interface RenderProcessGoneDetails {
  reason: RenderProcessGoneReason;
  exitCode?: number;
}

interface RecoveryLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface RendererRecoveryDeps {
  /** Monotonic-enough wall clock in ms. Tests inject a controllable one. */
  now: () => number;
  logger: RecoveryLogger;
  /**
   * Run a callback on a later task. Production wires `setImmediate`; tests
   * inject a captured queue so they can prove the reload does not happen on the
   * caller's stack. Load-bearing, not a convenience — see the comment above the
   * reload call for the browser-process crash this avoids.
   */
  defer: (fn: () => void) => void;
  /**
   * Surface the "this window stopped responding" choice once auto-reload is
   * exhausted, and resolve when the user has answered.
   *
   * MUST be non-blocking: wire `dialog.showMessageBox` (async), never
   * `dialog.showErrorBox`, which blocks the main process on macOS and would
   * freeze the very window being recovered.
   *
   * The returned promise is what lets recovery keep at most one dialog open per
   * webContents; resolving early would let a crash loop stack sheets.
   */
  promptManualRecovery: (contents: RecoverableWebContents, info: PromptInfo) => Promise<void>;
  /**
   * Crashes closer together than this count as one incident, so the auto-reload
   * budget does not refresh. A crash further out is a fresh incident and earns
   * a new budget. Default 60_000.
   */
  loopWindowMs?: number;
  /** Automatic reloads allowed per loop window. Default 1. */
  maxAutoReloads?: number;
  /**
   * Automatic reloads allowed for one webContents over its whole life,
   * regardless of how widely spaced the crashes are. Default 5.
   */
  maxLifetimeAutoReloads?: number;
}

interface PromptInfo {
  reason: RenderProcessGoneReason;
  exitCode?: number;
  /** Crashes seen for this webContents inside the current loop window. */
  crashesInWindow: number;
  /** Automatic reloads issued for this webContents since it was first seen. */
  lifetimeAutoReloads: number;
  /** Electron's `WebContents.id` for the window this prompt is about. */
  contentsId: number;
}

export interface RendererRecovery {
  /**
   * Handle one `render-process-gone`. Reloads, prompts, or ignores per the
   * policy above. Safe to call for any webContents — recovery state is created
   * lazily on first crash. Never throws: a reload that fails is logged, because
   * this runs inside an Electron event handler where an escaping exception
   * would take down the main process.
   */
  handleRenderProcessGone(
    contents: RecoverableWebContents,
    details: RenderProcessGoneDetails,
  ): void;
  /**
   * Release state for a webContents. Callers wire this to `destroyed` so a
   * closed window cannot pin its entry.
   *
   * Takes the contents explicitly rather than returning a disposer closure the
   * way `show-gate.ts` does, because there is no registration step to return
   * one from: crash signals arrive on an emitter that already exists, and the
   * first thing recovery learns about a webContents is that it has died.
   */
  dispose(contents: RecoverableWebContents): void;
}

/**
 * Reasons that mean the renderer died abnormally and a reload is the right
 * response. Mirrors `CRASH_REASONS` in `crash-detection.ts`.
 *
 * `killed` and `clean-exit` are ordinary teardown (including app quit), and
 * reloading on those would fight the shutdown path.
 *
 * `memory-eviction` looks like it belongs here — the window goes just as blank
 * — but it is excluded, on the policy argument alone: an eviction is Chromium
 * deliberately reclaiming a backgrounded renderer, so reloading re-spawns the
 * process it just freed.
 *
 * Whether an evicted renderer comes back on its own when its window is next
 * shown is assumed, not verified. If that assumption is wrong the blank-window
 * bug persists for evictions, which is why the ignored branch logs rather than
 * returning silently.
 *
 * That log establishes how often these reasons occur, and nothing more. Whether
 * anyone was actually stranded needs the window's subsequent lifecycle — a
 * close, a manual reload, a next paint — and none of that is recorded anywhere
 * today, so the outcome half stays open until renderer observability lands.
 */
const RECOVERABLE_REASONS = new Set<RenderProcessGoneReason>([
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
]);

/**
 * Ignored reasons that are ordinary lifecycle rather than a window left blank.
 * The rest of the ignored set (`abnormal-exit`, `memory-eviction`) does strand
 * the user, so it logs at warn to surface in bundle triage.
 */
const ROUTINE_TEARDOWN_REASONS = new Set<RenderProcessGoneReason>(['clean-exit', 'killed']);

const DEFAULT_LOOP_WINDOW_MS = 60_000;
const DEFAULT_MAX_AUTO_RELOADS = 1;
const DEFAULT_MAX_LIFETIME_AUTO_RELOADS = 5;

interface PerContentsState {
  /** Start of the current loop window. */
  windowStartedAt: number;
  /** Crashes seen since `windowStartedAt`. */
  crashes: number;
  /** Automatic reloads issued since `windowStartedAt`. */
  autoReloads: number;
  /** Automatic reloads issued since this webContents was first seen. Never reset. */
  lifetimeAutoReloads: number;
  /** A recovery dialog is open and unanswered for this webContents. */
  promptPending: boolean;
}

export function createRendererRecovery(deps: RendererRecoveryDeps): RendererRecovery {
  const states = new Map<RecoverableWebContents, PerContentsState>();
  const loopWindowMs = deps.loopWindowMs ?? DEFAULT_LOOP_WINDOW_MS;
  const maxAutoReloads = deps.maxAutoReloads ?? DEFAULT_MAX_AUTO_RELOADS;
  const maxLifetimeAutoReloads = deps.maxLifetimeAutoReloads ?? DEFAULT_MAX_LIFETIME_AUTO_RELOADS;

  return {
    handleRenderProcessGone(contents, details) {
      if (!RECOVERABLE_REASONS.has(details.reason)) {
        // Logged rather than dropped silently: the excluded reasons rest on
        // assumptions about what Chromium does next, and without a trace in the
        // bundle there is no way to find out from the field whether they hold.
        // Warn for the ones that leave the user looking at a blank window we
        // chose not to act on; ordinary teardown stays at info.
        const leavesBlankWindow = !ROUTINE_TEARDOWN_REASONS.has(details.reason);
        const line = {
          event: 'renderer-recovery.ignored',
          reason: details.reason,
          ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          contentsId: contents.id,
        };
        const msg = 'renderer process gone for a reason recovery does not act on';
        if (leavesBlankWindow) deps.logger.warn(line, msg);
        else deps.logger.info(line, msg);
        return;
      }

      // A window the user already closed has nothing to recover, and reloading
      // destroyed contents throws. Drop the entry so it cannot pin the Map.
      if (contents.isDestroyed()) {
        states.delete(contents);
        return;
      }

      const nowMs = deps.now();
      const prior = states.get(contents);
      // A crash further out than the loop window is a fresh incident, not a
      // continuation, so it earns a new per-window budget. Without this a
      // window that crashed once in the morning would never auto-recover
      // again. `lifetimeAutoReloads` and `promptPending` deliberately survive
      // the reset — they are what stop a renderer that dies just outside the
      // window every time from reloading silently forever.
      const state: PerContentsState =
        prior === undefined || nowMs - prior.windowStartedAt > loopWindowMs
          ? {
              windowStartedAt: nowMs,
              crashes: 0,
              autoReloads: 0,
              lifetimeAutoReloads: prior?.lifetimeAutoReloads ?? 0,
              promptPending: prior?.promptPending ?? false,
            }
          : prior;
      state.crashes += 1;
      states.set(contents, state);

      const crashFields = {
        reason: details.reason,
        ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
        crashesInWindow: state.crashes,
        lifetimeAutoReloads: state.lifetimeAutoReloads,
        contentsId: contents.id,
      };

      // Checked ahead of the budget gate, not inside it. While a dialog is open
      // the user already holds the decision, so recovery must take no action at
      // all — reloading behind an open prompt is both confusing and the thing
      // the prompt exists to avoid. A loop-window rollover resets the per-window
      // budget, so a check inside the gate would be skipped exactly when a
      // long-open dialog spans the rollover.
      if (state.promptPending) {
        deps.logger.info(
          { event: 'renderer-recovery.prompt-suppressed', ...crashFields },
          'recovery prompt is already open for this window',
        );
        return;
      }

      const windowBudgetSpent = state.autoReloads >= maxAutoReloads;
      const lifetimeBudgetSpent = state.lifetimeAutoReloads >= maxLifetimeAutoReloads;

      if (windowBudgetSpent || lifetimeBudgetSpent) {
        deps.logger.warn(
          {
            event: 'renderer-recovery.loop-detected',
            ...crashFields,
            exhausted: lifetimeBudgetSpent ? 'lifetime' : 'window',
          },
          'renderer died again after an automatic reload — asking the user instead of reloading',
        );
        state.promptPending = true;
        // Reads the live entry instead of closing over `state`: a loop-window
        // rollover while the dialog is open replaces the object in the Map, and
        // clearing the orphan would leave the current entry pending forever,
        // permanently suppressing the affordance for this window.
        const clear = () => {
          const current = states.get(contents);
          if (current !== undefined) current.promptPending = false;
        };
        // Rejection clears the flag AND logs. The wiring catches its own dialog
        // failures today, so this is a last resort, but a silent async path
        // would leave a future wiring's failures invisible while the sync-throw
        // path below is loud.
        const clearAndLog = (err: unknown) => {
          clear();
          deps.logger.warn(
            { event: 'renderer-recovery.prompt-failed', ...crashFields, err },
            'recovery prompt rejected',
          );
        };
        try {
          deps.promptManualRecovery(contents, crashFields).then(clear, clearAndLog);
        } catch (err: unknown) {
          clear();
          deps.logger.warn(
            { event: 'renderer-recovery.prompt-failed', ...crashFields, err },
            'recovery prompt threw synchronously',
          );
        }
        return;
      }

      state.autoReloads += 1;
      state.lifetimeAutoReloads += 1;
      deps.logger.info(
        {
          event: 'renderer-recovery.reloading',
          ...crashFields,
          autoReloads: state.autoReloads,
          lifetimeAutoReloads: state.lifetimeAutoReloads,
        },
        'renderer died — reloading the window automatically',
      );
      // The reload MUST NOT run on the caller's stack. Electron emitted
      // `render-process-gone` synchronously from inside Chromium's
      // process-death observer loop, and reloading from there re-entered
      // `RenderProcessHostImpl::Init()` mid-iteration; the relaunched renderer
      // then failed a CHECK and took the whole browser process down. A
      // try/catch cannot contain it — the CHECK fires a turn later, long after
      // `reload()` has returned normally. Deferring by one task lets the
      // notification unwind first. Upstream fixed the re-entrancy in
      // electron/electron#51900 (backported to 41-x-y as #51917, shipped in
      // the 41.9.1 this app pins). The deferral deliberately outlives that
      // fix: staying off the observer stack is cheap insurance against an
      // upstream regression, and the deferral window is observable contract
      // (the reload-abandoned branch below) — removing it is its own
      // decision, not a version-bump side effect.
      deps.defer(() => {
        // The whole body is guarded, not just the reload. This runs on a later
        // task, so nothing above is on the stack to catch it and an escaping
        // exception — including one from a misbehaving injected logger — would
        // surface as an unhandled rejection in the main process.
        try {
          // Re-checked inside the deferred task: the deferral is exactly a
          // window in which the user can close the window. Logged rather than
          // returning silently — the `reloading` line above already claimed the
          // reload as fact, so without a counter-record a bundle cannot tell a
          // reload that happened from one abandoned here.
          if (contents.isDestroyed()) {
            deps.logger.info(
              { event: 'renderer-recovery.reload-abandoned', ...crashFields },
              'window closed during the reload deferral — nothing left to reload',
            );
            return;
          }
          contents.reload();
        } catch (err: unknown) {
          // Deliberately terminal: this window keeps its blank frame and gets no
          // prompt. Reaching here means `reload()` threw on contents that report
          // themselves alive, which no known path produces; routing it into the
          // prompt would add a branch through the pending-prompt bookkeeping for
          // a case that cannot be exercised, and the user still has Cmd-R and
          // the crash-report invitation. The log is the signal that the
          // assumption broke.
          deps.logger.warn(
            { event: 'renderer-recovery.reload-failed', ...crashFields, err },
            'renderer reload threw past the destroyed guard — window stays blank',
          );
        }
      });
    },
    dispose(contents) {
      states.delete(contents);
    },
  };
}
