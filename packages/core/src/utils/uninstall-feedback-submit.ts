import type { UninstallFeedbackReason } from '../constants/uninstall-feedback.ts';

/**
 * Best-effort churn-survey transport for the two non-React uninstall surfaces —
 * the desktop uninstall window (Electron main) and `ok uninstall`. Both are
 * plain Node, so this deliberately avoids the browser-only machinery in the
 * editor app's `lib/feedback.ts` (`FileReader`, `import.meta.env`).
 *
 * It resolves rather than throws on every failure: the caller is midway through
 * removing OpenKnowledge, and a dropped feedback POST must never surface as an
 * error or stall the removal past the timeout ceiling.
 */

/** Which uninstall surface collected the answers — bounded, for analytics. */
export type UninstallFeedbackSource = 'desktop_uninstall' | 'cli_uninstall';

/** The part a departing user fills in; every field is optional by design. */
export interface UninstallFeedbackAnswers {
  /** The single primary reason, when one was picked. */
  reason?: UninstallFeedbackReason;
  /** Free-text elaboration, sent as the ticket `message`. */
  note?: string;
  /** Follow-up address, sent only when the user opted in. */
  email?: string;
}

export interface UninstallFeedbackSubmission extends UninstallFeedbackAnswers {
  source: UninstallFeedbackSource;
  appVersion: string;
  platform: string;
}

export interface PostUninstallFeedbackOptions {
  /**
   * Ceiling on the whole operation, including the retry a rejected address
   * triggers; the caller proceeds once it elapses.
   */
  timeoutMs?: number;
}

// Diverges from the in-app `FeedbackResult` (app/src/lib/feedback.ts) by one
// member: `timeout`. That path is browser-driven with no `app.quit()` deadline
// pressing on it, so it never has to distinguish a bounded-wait abandonment from
// a plain error. The desktop/CLI path does, because the survey is flushed before
// the process exits, so the extra variant is deliberate, not drift.
export type UninstallFeedbackResult =
  | { ok: true; reference: string }
  // `invalid` — rejected as malformed (400) or oversized (413).
  // `unavailable` — feedback is turned off server-side (503).
  // `timeout` — abandoned at the ceiling; the request may still land.
  // `error` — anything else (5xx, network, unusable origin).
  | { ok: false; reason: 'invalid' | 'unavailable' | 'timeout' | 'error' };

/**
 * Shipped default, matching the desktop bug-report intake: a GUI-launched app
 * never receives a shell env var, so the production origin has to be baked in.
 */
const DEFAULT_INTAKE_ORIGIN = 'https://openknowledge.ai';

/**
 * Short enough that a departing user never notices the wait, long enough for
 * the POST to flush before the desktop flow reaches `app.quit()` — a
 * fire-and-forget request would be torn down mid-flight in a packaged build.
 */
const DEFAULT_TIMEOUT_MS = 4_000;

/** Collapses whitespace-only input to absent — the intake rejects `email: ''`. */
function presentText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Whether the user actually left anything worth filing. Both surfaces gate
 * their POST on this so an untouched form can't create an empty churn ticket,
 * and so neither can drift on what counts as empty.
 */
export function hasUninstallFeedbackContent(answers: UninstallFeedbackAnswers): boolean {
  return (
    answers.reason !== undefined ||
    presentText(answers.note) !== undefined ||
    presentText(answers.email) !== undefined
  );
}

/**
 * Admit an intake origin only when transport-safe: `https:` anywhere, or plain
 * `http:` strictly on loopback, so a dev run can point at a local marketing
 * server. Anything else would carry a departing user's note — and the email
 * address they just handed over — in cleartext to a MITM-able endpoint. Mirrors
 * the bug-report upload's gate; transport encryption is all either one claims.
 */
function transportSafeOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'http:' && loopback ? url : null;
}

/**
 * `null` when the configured origin is unusable — the send then fails rather
 * than quietly reverting to the shipped origin, so a misconfigured env can
 * never redirect the answers somewhere unintended.
 */
function resolveIntakeOrigin(): URL | null {
  // Core also ships into the browser bundle, where `process` does not exist.
  const fromEnv =
    typeof process === 'undefined'
      ? undefined
      : presentText(process.env?.OK_FEEDBACK_INTAKE_ORIGIN);
  return transportSafeOrigin(fromEnv ?? DEFAULT_INTAKE_ORIGIN);
}

/**
 * A cheap first pass at the address, so the ordinary `me@` / `me.com` typo
 * never costs a round trip. Deliberately NOT an attempt to mirror the intake's
 * validator: that one lives across the mirror boundary and is stricter in ways
 * this cannot track, which is why a rejection is also recovered from below.
 */
function plausibleEmail(value: string | undefined): string | undefined {
  const trimmed = presentText(value);
  if (trimmed === undefined) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined;
}

async function sendFeedback(
  url: URL,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<UninstallFeedbackResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      // The ticket is filed; an unparseable body only costs us the reference,
      // which no uninstall surface displays.
      const data = (await response.json().catch(() => null)) as { reference?: unknown } | null;
      return { ok: true, reference: typeof data?.reference === 'string' ? data.reference : '' };
    }
    if (response.status === 400 || response.status === 413) return { ok: false, reason: 'invalid' };
    if (response.status === 503) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'error' };
  } catch (err) {
    // The network is the trust boundary: offline, DNS failure, a hung intake
    // hitting the ceiling, or an unusable configured origin all land here.
    // Runtimes disagree on whether an `AbortSignal.timeout()` abort carries
    // `TimeoutError` or `AbortError`, so both count as the ceiling firing.
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'error' };
  }
}

/**
 * File one uninstall-feedback ticket. Callers should first check
 * {@link hasUninstallFeedbackContent} — this posts whatever it is handed.
 */
export async function postUninstallFeedback(
  submission: UninstallFeedbackSubmission,
  options: PostUninstallFeedbackOptions = {},
): Promise<UninstallFeedbackResult> {
  const origin = resolveIntakeOrigin();
  if (origin === null) return { ok: false, reason: 'error' };
  const url = new URL('/api/feedback', origin);
  const message = presentText(submission.note);
  const email = plausibleEmail(submission.email);
  const body = {
    kind: 'uninstall',
    reasons: submission.reason === undefined ? [] : [submission.reason],
    ...(message === undefined ? {} : { message }),
    appVersion: submission.appVersion,
    platform: submission.platform,
    source: submission.source,
  };
  // One ceiling for the whole operation, retry included, so the departing user
  // waits no longer than the caller budgeted for.
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = (): number => deadline - Date.now();

  if (email === undefined) return sendFeedback(url, body, remaining());
  const withEmail = await sendFeedback(url, { ...body, email }, remaining());
  // The intake validates the whole body at once, so an address this side let
  // through but its stricter validator rejects would take the reason and the
  // note down with it. Refile without the address: those are what the survey
  // exists to collect, and a rejected body never reached the ticket tracker,
  // so this cannot duplicate one.
  if (withEmail.ok || withEmail.reason !== 'invalid' || remaining() <= 0) return withEmail;
  return sendFeedback(url, body, remaining());
}
