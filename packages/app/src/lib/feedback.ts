import { BROWSER_RUNTIME_VERSION } from './client-version';

const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

const FEEDBACK_ENDPOINT = new URL(
  '/api/feedback',
  importMetaEnv?.VITE_OK_FEEDBACK_INTAKE_ORIGIN || 'https://openknowledge.ai',
).href;

type FeedbackKind = 'general' | 'uninstall';
type FeedbackRating = 'positive' | 'negative';

/*
 * WARN: the intake route accepts exactly these image types, and app and
 * marketing deploy separately, so drift here only shows up as rejected uploads.
 */
type FeedbackImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface FeedbackAttachmentPayload {
  contentType: FeedbackImageType;
  base64: string;
}

export interface FeedbackPayload {
  kind: FeedbackKind;
  rating?: FeedbackRating;
  reasons: string[];
  message?: string;
  email?: string;
  attachments?: FeedbackAttachmentPayload[];
  source?: string;
}

export type FeedbackResult =
  | { ok: true; reference: string }
  | { ok: false; reason: 'invalid' | 'unavailable' | 'error' };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

export async function fileToFeedbackAttachment(file: File): Promise<FeedbackAttachmentPayload> {
  return { contentType: file.type as FeedbackImageType, base64: await fileToBase64(file) };
}

function resolvePlatform(): string {
  return (typeof window !== 'undefined' && window.okDesktop?.platform) || 'web';
}

export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
  try {
    const response = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        appVersion: BROWSER_RUNTIME_VERSION,
        platform: resolvePlatform(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const data = (await response.json().catch((err) => {
        console.warn(
          `[feedback] action=submit result=ok-parse-error message=${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      })) as { reference?: unknown } | null;
      const reference = data && typeof data.reference === 'string' ? data.reference : '';
      return { ok: true, reference };
    }
    if (response.status === 400 || response.status === 413) {
      return { ok: false, reason: 'invalid' };
    }
    if (response.status === 503) {
      return { ok: false, reason: 'unavailable' };
    }
    console.warn(`[feedback] action=submit result=http-error status=${response.status}`);
    return { ok: false, reason: 'error' };
  } catch (err) {
    console.warn(
      `[feedback] action=submit result=network-error message=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { ok: false, reason: 'error' };
  }
}
