/**
 * Feedback transport. Like the subscribe + bug-report flows, the editor app is
 * served locally (Electron / `localhost`) with no backend that could hold the
 * Linear secret, so we POST cross-origin to the `/api/feedback` route served
 * centrally at the apex (the route answers CORS + preflight for this reason).
 *
 * Single-shot: the payload carries any images inline as base64 (the route caps
 * the total well under Vercel's request-body limit), and the response returns
 * the filed Linear issue reference.
 */
import { BROWSER_RUNTIME_VERSION } from './client-version';

const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

// Intake origin: the apex by default, overridable at dev time to a locally-run
// marketing site (Vite exposes `VITE_*` env). The web analog of the desktop
// bug-report client's `OK_BUG_REPORT_INTAKE_URL` seam:
//   VITE_OK_FEEDBACK_INTAKE_ORIGIN=http://localhost:3200 pnpm dev
const FEEDBACK_ENDPOINT = new URL(
  '/api/feedback',
  importMetaEnv?.VITE_OK_FEEDBACK_INTAKE_ORIGIN || 'https://openknowledge.ai',
).href;

type FeedbackKind = 'general' | 'uninstall';
type FeedbackRating = 'positive' | 'negative';

// The route accepts only these image types; kept in sync with the intake schema
// (a cross-deploy contract — app and marketing ship separately).
type FeedbackImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface FeedbackAttachmentPayload {
  contentType: FeedbackImageType;
  /** Base64 with no `data:` prefix. */
  base64: string;
}

export interface FeedbackPayload {
  kind: FeedbackKind;
  rating?: FeedbackRating;
  reasons: string[];
  message?: string;
  email?: string;
  attachments?: FeedbackAttachmentPayload[];
  /** Which in-app surface opened the form (bounded, for analytics). */
  source?: string;
}

export type FeedbackResult =
  | { ok: true; reference: string }
  // `invalid` — the payload was rejected (400) or too large (413).
  // `unavailable` — feedback is turned off server-side (503).
  // `error` — anything else (Linear failure, network, parse): retryable.
  | { ok: false; reason: 'invalid' | 'unavailable' | 'error' };

/** Reads a File into base64 (no `data:` prefix), for inline transport. */
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

/** Maps a picked image File to the wire attachment shape. */
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
      // Longer than subscribe: the request carries image bytes and the route
      // uploads them to Linear before filing. Matches the route's maxDuration.
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      // The report filed (200); a parse failure only costs us the Linear
      // reference in the success toast, so warn (for drift diagnosis) but still
      // report success rather than a spurious error.
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
    // Log HTTP errors (502/500/429/...) for parity with the network-error path.
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
