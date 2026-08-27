/**
 * Publishes editor `content-visibility: auto` relevance transitions as a
 * desktop crash key, so a renderer abort can be told apart from a renderer that
 * merely died near one.
 *
 * WHY THIS EXISTS. Blink hard-CHECKs in `HitTestResult::GetPosition()` when a
 * click's hit-tested node has a paint-blocked ANCESTOR. OK stamps
 * `.ok-chunk-wrapper` (`content-visibility: auto`) on every top-level
 * ProseMirror block, and a minidump carries the faulting stack but nothing
 * about renderer DOM or CSS state — so when that abort shows up in the field,
 * whether a chunk wrapper was flipping relevance at the time is exactly the
 * question triage cannot answer, and the one this key answers.
 *
 * SCOPE: CHUNK WRAPPERS ONLY, AND THAT IS A HARD LIMIT, NOT A CHOICE.
 * `contentvisibilityautostatechange` fires only for elements whose own
 * `content-visibility` is `auto` — Blink schedules it behind
 * `state_ == EContentVisibility::kAuto` in
 * `DisplayLockContext::ScheduleStateChangeEventIfNeeded`. OK's other
 * display-lock site, `.ok-mode-hidden`, is `content-visibility: hidden`, so it
 * can never fire this event and is structurally outside what this key can see.
 * An earlier draft mapped that class too; the arm was dead, and worse, on a
 * `.ok-mode-hidden` crash the key would have carried leftover chunk-wrapper
 * state and invited triage to read it as relevant. Covering the pane site would
 * need a different mechanism (its class flip is React state, not this event)
 * and is deliberately not attempted here.
 *
 * WHY IT IS CONTINUOUS RATHER THAN CAPTURED AT CRASH TIME. The CHECK is an
 * immediate process abort. No JS runs after it fires, so there is no crash
 * handler to ask. The only value that reaches the dump is the one last written
 * before the abort.
 *
 * WHY A READING CAN BE DATED. A high-water mark alone would be untriageable: a
 * burst from a scroll minutes earlier and a burst in flight during the crashing
 * frame would publish identical values. So a burst publishes `s=0` (live), and
 * the first frame afterwards with no new transitions republishes `s=1`
 * (settled). A dump carrying `s=0` says a transition burst had not finished
 * when the process died; `s=1` says the last burst had already settled. That
 * costs one extra write per burst, not per frame.
 *
 * WHY CAPTURE PHASE ON A ROOT, NOT PER-ELEMENT LISTENERS. A capture-phase
 * listener on an ancestor fires for events dispatched at any descendant whether
 * or not the event bubbles, so one listener covers every wrapper without
 * depending on the event's bubbling behavior and without attaching hundreds of
 * listeners that ProseMirror's decorations would churn.
 *
 * WHY IT COALESCES PER FRAME. Scrolling a long document produces transitions in
 * bursts — a mid-document jump measured ~100 in one go — and
 * `content-visibility: auto` exists here for render performance, so this must
 * not become the thing that costs it. Transitions fold into one pending
 * snapshot published at most once per animation frame, and nothing is published
 * while the document is idle.
 */

import { OK_CHUNK_WRAPPER_CLASS } from './extensions/chunk-wrapper-decoration.ts';

export interface DisplayLockSnapshot {
  /** True when the most recent transition was INTO the paint lock. */
  locked: boolean;
  /** Transitions folded into the frame being published. */
  inFrame: number;
  /** Transitions observed since the reporter started. */
  total: number;
  /**
   * True once a frame has passed with no further transitions. A dump carrying
   * `false` died with a burst still in flight.
   */
  settled: boolean;
}

/**
 * Ceiling on every published counter.
 *
 * Counters exist to say "a burst was in flight", not to be exact, so they
 * saturate rather than grow. Saturating is what makes the encoded value's
 * length provably bounded, which is what keeps it clear of the byte ceiling the
 * desktop bridge enforces — a value over that ceiling is dropped, and a
 * diagnostic that silently stops publishing under load would be worse than
 * none, because load is exactly when it matters.
 */
const COUNTER_CEILING = 99_999;

function saturate(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > COUNTER_CEILING ? COUNTER_CEILING : Math.floor(n);
}

/**
 * Encode a snapshot as the compact ASCII string the crash key carries.
 *
 * Versioned so a dump read years from now is self-describing: `v1` means
 * chunk-wrapper cv:auto transitions with these four fields, and a later shape
 * changes the prefix rather than silently redefining them. Fixed field set and
 * saturated counters make the maximum length a constant, which
 * `display-lock-crash-key.test.ts` pins against the bridge's budget.
 */
export function encodeDisplayLockState(snapshot: DisplayLockSnapshot): string {
  const lock = snapshot.locked ? '1' : '0';
  const settled = snapshot.settled ? '1' : '0';
  return `v1 lock=${lock} f=${saturate(snapshot.inFrame)} n=${saturate(snapshot.total)} s=${settled}`;
}

/**
 * Structural minimum this module needs from an event target.
 *
 * Deliberately not `instanceof Element`. Nothing here needs an `Element` — one
 * `classList.contains` call is the whole requirement — and structural typing
 * keeps the module loadable wherever it is imported, including the node test
 * tier, without a DOM shim standing in for a check it never had to make. It
 * reads the same property either way.
 */
interface ClassListBearing {
  classList: { contains(token: string): boolean };
}

function isChunkWrapper(target: EventTarget | null): boolean {
  const classList = (target as ClassListBearing | null)?.classList;
  if (typeof classList?.contains !== 'function') return false;
  return classList.contains(OK_CHUNK_WRAPPER_CLASS);
}

/** The listener surface this module needs from its root. */
interface ListenerTarget {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { capture?: boolean },
  ): void;
}

/**
 * The desktop bridge's crash-key writer, or undefined when there is none.
 *
 * `typeof window` rather than a bare `window.okDesktop`: this module's unit
 * tests run in the node environment, where the global does not exist and a
 * direct read throws `ReferenceError` rather than yielding undefined. Same
 * guard `main.tsx` uses to read the bridge at startup.
 */
function desktopSink(): ((state: string) => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  // Capability check, not just a host check — the same reasoning
  // `BackgroundThrottleReporter` records for its own bridge channel. The
  // preload bridge is a cross-process contract the renderer cannot enforce, so
  // a shell built before this method existed exposes `okDesktop` without it.
  // The type says the method is always there; the running shell is what
  // decides. A crash annotation is a diagnostic, and its absence must never
  // take down the editor.
  const publish = window.okDesktop?.setDisplayLockCrashKey;
  if (typeof publish !== 'function') return undefined;
  return publish;
}

export interface DisplayLockReporterOptions {
  /** Root to observe; every chunk wrapper lives beneath it. */
  root: ListenerTarget;
  /** Sink for the encoded value. Defaults to the desktop bridge. */
  publish?: (state: string) => void;
  /** Frame scheduler, injectable so tests need no real animation frames. */
  schedule?: (run: () => void) => void;
}

/**
 * Start publishing chunk-wrapper relevance transitions. Returns a stop function
 * that detaches the listener; a pending frame callback after stop is a no-op.
 *
 * Publishing is skipped entirely when no sink is available, which is the normal
 * case outside the desktop app: there is no crash database to annotate in a
 * browser, so nothing is attached at all.
 */
export function startDisplayLockCrashKeyReporter(options: DisplayLockReporterOptions): () => void {
  // No sink means no crash database to annotate — the browser build, or any
  // host with no `window` at all. Attaching anyway would run the handler on
  // every transition to feed a no-op, and transitions come in bursts during
  // exactly the scrolling `content-visibility: auto` exists to keep cheap.
  // Decline outright instead.
  const publish = options.publish ?? desktopSink();
  if (publish === undefined) return () => {};
  const schedule = options.schedule ?? ((run: () => void) => requestAnimationFrame(run));

  let stopped = false;
  let frameScheduled = false;
  let inFrame = 0;
  let total = 0;
  let locked = false;
  /** Frame count of the burst last published, reused by the settled republish. */
  let lastBurst = 0;
  /** True between publishing a burst and confirming it has stopped. */
  let burstLive = false;

  /**
   * Hand a value to the sink without letting a failure reach the frame loop.
   *
   * `publish` crosses the contextBridge into a native binding, so a throw is
   * not hypothetical. Swallowing it is deliberate: this is a diagnostic, and
   * the module's whole premise is that it must not cost the editor anything.
   * An unguarded throw here would do the opposite — it escapes into the rAF
   * callback, so the frame's bookkeeping never completes and the next
   * transition re-arms into the identical throw, once per frame for the whole
   * scroll burst, which is exactly when `content-visibility: auto` is meant to
   * be cheap.
   */
  const publishSafely = (state: string): void => {
    try {
      publish(state);
    } catch {
      // Nothing to recover: the annotation for this frame is simply lost, and
      // the next transition publishes a fresh one.
    }
  };

  const onFrame = (): void => {
    frameScheduled = false;
    if (stopped) return;

    if (inFrame === 0) {
      // A frame with no new transitions: the burst just published has stopped.
      // Republish once, marked settled, so a dump can tell a live burst from
      // residue. Then go quiet until the next transition.
      if (burstLive) {
        burstLive = false;
        publishSafely(encodeDisplayLockState({ locked, inFrame: lastBurst, total, settled: true }));
      }
      return;
    }

    // Bookkeeping is settled BEFORE publishing, so a sink that misbehaves
    // cannot leave `inFrame` accumulating across frames and inflating every
    // later reading.
    const burst = inFrame;
    lastBurst = burst;
    inFrame = 0;
    burstLive = true;
    // Re-arm to detect the end of the burst. If more transitions arrive first,
    // this same callback publishes them instead and re-arms again.
    frameScheduled = true;
    schedule(onFrame);
    publishSafely(encodeDisplayLockState({ locked, inFrame: burst, total, settled: false }));
  };

  const onTransition = (event: Event): void => {
    if (!isChunkWrapper(event.target)) return;
    // The DOM lib declares this event with a REQUIRED `skipped: boolean`, so
    // narrow to it rather than to a hand-rolled optional field — a guessed
    // shape would type-check clean against itself if the contract ever moved.
    locked = (event as ContentVisibilityAutoStateChangeEvent).skipped;
    inFrame += 1;
    total += 1;
    if (frameScheduled) return;
    frameScheduled = true;
    schedule(onFrame);
  };

  options.root.addEventListener('contentvisibilityautostatechange', onTransition, {
    capture: true,
  });
  return () => {
    stopped = true;
    options.root.removeEventListener('contentvisibilityautostatechange', onTransition, {
      capture: true,
    });
  };
}
