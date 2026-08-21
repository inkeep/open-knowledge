/**
 * The facts a `desktop.accessibility` line carries, and the one rule that makes
 * them readable: a reading that did not happen must not look like a reading
 * that came back empty.
 *
 * A family of renderer crashes reaches a Blink `CHECK` that is only reachable
 * with a live accessibility tree. Chromium builds that tree lazily, once it
 * detects an attached assistive-technology client, so on a report where the
 * app's own force switch was not set, the precondition of the whole diagnosis
 * has to be read off the log or guessed at. This line is what makes it
 * readable on every session, crash or not — and it timestamps WHEN a client
 * attached, which a crash dump cannot say.
 *
 * Lives here rather than inline in the main entry point because that module
 * cannot be unit-tested: importing it boots Electron. The Electron calls stay
 * at the call site and their RESULTS arrive here as plain values, so the
 * decision this module owns — what an absent reading means — is checkable
 * without an app.
 */

/** How a caller reads the browser process's live accessibility flag set. */
export type AccessibilityFeatureReader = (() => string[]) | undefined;

export interface AccessibilityPostureInput {
  phase: 'boot' | 'changed';
  /**
   * Chromium's own "is this an accessible browser" predicate over the current
   * mode. Kept alongside `features` because it is NOT derivable from that
   * array: it is a predicate over the whole mode rather than a test for any one
   * flag, and recomputing it here would be this module guessing at it.
   */
  supportEnabled: boolean;
  /**
   * The flag set, or null when it could not be read. Null is the whole point of
   * this type — see `resolveAccessibilityFeatures`.
   */
  features: string[] | null;
  /** Whether the app forced the tree on, which moots both readings above. */
  forcedByEnv: boolean;
}

/**
 * Read the flag set, distinguishing "came back empty" from "could not read".
 *
 * `[]` and null are DIFFERENT ANSWERS, and collapsing them is the failure this
 * module exists to prevent. An empty array is a real reading: no accessibility
 * modes are active. Null means the reading did not happen — the method is
 * missing on an Electron older than the one that added it, or it threw — and an
 * incident responder has to be able to tell those apart, exactly as the
 * crash-side sites distinguish a dump that named no mode from no dump having
 * been read at all.
 *
 * `onError` is not optional in spirit: a guard that swallows its error removes
 * the only signal that it ever fired, and this one sits where a throw would
 * otherwise take a boot down. Where that warning goes is the caller's business.
 *
 * What this module's contract turns on is only that the reader MAY be absent,
 * and that its one real absence case is an Electron older than the method —
 * not a platform. Which platforms the underlying Electron method actually
 * works on, and the version-pinned citation backing that, live once with the
 * call site rather than being restated here: a claim in two places is a claim
 * that can go stale in one of them, and this particular claim has already been
 * shipped wrong and retracted once.
 */
export function resolveAccessibilityFeatures(
  read: AccessibilityFeatureReader,
  onError: (error: unknown) => void,
): string[] | null {
  if (read === undefined) return null;
  try {
    return read();
  } catch (error) {
    onError(error);
    return null;
  }
}

/**
 * The log payload. `features` is present only when it was actually read, so its
 * absence says "we could not look" while `[]` says "we looked and nothing was
 * active" — the same present-vs-absent convention the crash-detection and
 * bug-report sites use for the accessibility mode read off a dump.
 */
export function accessibilityPostureFacts(
  input: AccessibilityPostureInput,
): Record<string, unknown> {
  return {
    event: 'desktop.accessibility',
    phase: input.phase,
    supportEnabled: input.supportEnabled,
    ...(input.features !== null ? { features: input.features } : {}),
    forcedByEnv: input.forcedByEnv,
  };
}
