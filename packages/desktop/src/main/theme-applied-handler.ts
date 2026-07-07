/**
 * Pure handler for the `ok:theme:applied` IPC channel — multiplexes three
 * orthogonal renderer signals onto one channel:
 *
 *   1. Per-window show-gate release. The renderer fires once after
 *      ConfigProvider's first sync settles; main resolves the sender's
 *      BrowserWindow and unblocks `BrowserWindow.show()` (combined with
 *      `ready-to-show` — see `show-gate.ts`).
 *
 *   2. Cross-window vibrancy fan-out. The optional `opts.reducedTransparency`
 *      payload drives `setVibrancy` across every open BrowserWindow via
 *      `applyReducedTransparency`, whose per-window memo collapses the
 *      redundant theme-change re-applies that would otherwise flicker
 *      `transparent: true` windows (rationale lives on `lastAppliedMaterial`
 *      in `reduced-transparency-handler.ts`).
 *
 *   3. Renderer-mount acknowledgment for the cold-launch staleness window.
 *      The first fire of this channel is also the renderer's "I'm here
 *      and the theme is consistent" signal — implicit but load-bearing.
 *
 * The three concerns share a channel rather than splitting because the
 * commitment to migrate to typed-ipc (`@egoist/tipc` / `@electron-toolkit/
 * typed-ipc`) fires before any further hand-rolled channel additions —
 * payload-widening on an existing channel is the right fit until that
 * migration lands.
 *
 * Architectural seam: the handler body lives here as a pure DI'd function
 * (mirrors `applyThemeSource` and `applyReducedTransparency`) so the
 * composition can be unit-tested without an Electron process. `index.ts`
 * resolves `event.sender` → BrowserWindow and threads it through; this
 * function only sees the structural collaborators it actually invokes.
 */

interface ApplyThemeAppliedDeps {
  /** Forward to `showGate.fireThemeApplied(window)`. */
  fireThemeApplied: (window: object) => void;
  /** Forward to `applyReducedTransparency(reducedTransparencyDeps, reduced)`. */
  applyReducedTransparency: (reduced: boolean) => void;
  /** Diagnostic sink for structured warn lines. Production wires console.warn. */
  warn: (line: string) => void;
}

/**
 * Apply the renderer's `ok:theme:applied` signal. Two independent effects,
 * ordered vibrancy-before-show-gate so cold-launch users with macOS Reduce
 * Transparency enabled never see a frame with the default 'sidebar'
 * material before `setVibrancy(null)` lands:
 *
 *   - When `opts.reducedTransparency` is explicitly defined, fan out to
 *     vibrancy FIRST. The `!== undefined` guard is load-bearing — without
 *     it, the cold-launch theme-applied signal (which carries no payload
 *     on first fire) would coerce `undefined` to falsy and re-set every
 *     window's vibrancy on every fire. Fan-out runs even when
 *     `senderWindow` is null because vibrancy targets every open window,
 *     not just the sender's.
 *
 *   - When `senderWindow` resolves, fire the show-gate signal AFTER
 *     vibrancy has been applied. The window only becomes visible at this
 *     point, so the first composited frame already reflects the resolved
 *     vibrancy state. When it is null (sender's window detached mid-IPC,
 *     closing race), emit a structured warn so the downstream 5 s
 *     show-gate timeout's `missing: 'theme-applied'` warn isn't the only
 *     diagnostic trail — this surfaces the upstream cause (renderer DID
 *     fire, main couldn't resolve the window).
 */
export function applyThemeApplied(
  deps: ApplyThemeAppliedDeps,
  senderWindow: object | null,
  opts: { reducedTransparency?: boolean } | undefined,
): void {
  if (opts?.reducedTransparency !== undefined) {
    deps.applyReducedTransparency(opts.reducedTransparency);
  }
  if (senderWindow !== null) {
    deps.fireThemeApplied(senderWindow);
  } else {
    deps.warn(
      JSON.stringify({
        event: 'theme-applied-no-window-for-sender',
      }),
    );
  }
}
