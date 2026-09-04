import type { UninstallFeedbackReason } from '../constants/uninstall-feedback.ts';

export type UninstallFeedbackSource = 'desktop_uninstall' | 'cli_uninstall';

export interface UninstallFeedbackAnswers {
  reason?: UninstallFeedbackReason;
  note?: string;
  email?: string;
}

export interface UninstallFeedbackSubmission extends UninstallFeedbackAnswers {
  source: UninstallFeedbackSource;
  appVersion: string;
  platform: string;
}

export interface PostUninstallFeedbackOptions {
  timeoutMs?: number;
}

export type UninstallFeedbackResult =
  | { ok: true; reference: string }
  | { ok: false; reason: 'invalid' | 'unavailable' | 'timeout' | 'error' };

const DEFAULT_INTAKE_ORIGIN = 'https://openknowledge.ai';

const DEFAULT_TIMEOUT_MS = 4_000;

function presentText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function hasUninstallFeedbackContent(answers: UninstallFeedbackAnswers): boolean {
  return (
    answers.reason !== undefined ||
    presentText(answers.note) !== undefined ||
    presentText(answers.email) !== undefined
  );
}

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

function resolveIntakeOrigin(): URL | null {
  const fromEnv =
    typeof process === 'undefined'
      ? undefined
      : presentText(process.env?.OK_FEEDBACK_INTAKE_ORIGIN);
  return transportSafeOrigin(fromEnv ?? DEFAULT_INTAKE_ORIGIN);
}

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
      const data = (await response.json().catch(() => null)) as { reference?: unknown } | null;
      return { ok: true, reference: typeof data?.reference === 'string' ? data.reference : '' };
    }
    if (response.status === 400 || response.status === 413) return { ok: false, reason: 'invalid' };
    if (response.status === 503) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'error' };
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'error' };
  }
}

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
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = (): number => deadline - Date.now();

  if (email === undefined) return sendFeedback(url, body, remaining());
  const withEmail = await sendFeedback(url, { ...body, email }, remaining());
  if (withEmail.ok || withEmail.reason !== 'invalid' || remaining() <= 0) return withEmail;
  return sendFeedback(url, body, remaining());
}
