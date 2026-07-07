/**
 * Email-subscription transport. The editor app is served locally (Electron /
 * `localhost`) and its Hocuspocus server runs on the user's machine, so there
 * is no local backend that could hold the Resend secret. The `/api/subscribe`
 * route is served centrally at the apex (by the marketing app), so we POST
 * cross-origin to it (the route answers CORS + preflight for this reason).
 */
const SUBSCRIBE_ENDPOINT = 'https://openknowledge.ai/api/subscribe';

// Which in-app surface a signup came from, sent to the newsletter route so
// PostHog can attribute signups per surface. A cross-deploy contract with the
// route's `source` allowlist
// — the app and marketing ship separately, so keep the two in sync. The
// `marketing_site` value belongs to the marketing app; the app sends only its
// own two surfaces.
export type SubscribeSource = 'resources_menu' | 'post_update_card';

export type SubscribeResult =
  | { ok: true }
  // `invalid` — the address was rejected (mirrors the route's 400).
  // `unavailable` — subscriptions are turned off server-side (503).
  // `error` — anything else (Resend failure, network, parse): retryable.
  | { ok: false; reason: 'invalid' | 'unavailable' | 'error' };

export async function submitSubscribe(
  email: string,
  source: SubscribeSource,
): Promise<SubscribeResult> {
  try {
    const response = await fetch(SUBSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, source }),
      // Without a timeout, a stalled connection (captive portal, proxy hang)
      // leaves the fetch pending forever and the Submit button spinning. The
      // AbortError is caught below and surfaces as a retryable error.
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      return { ok: true };
    }
    if (response.status === 400) {
      return { ok: false, reason: 'invalid' };
    }
    if (response.status === 503) {
      return { ok: false, reason: 'unavailable' };
    }
    // Log HTTP errors (502/500/429/...) for client-side parity with the
    // network-error path below — otherwise server-error responses are silent.
    console.warn(`[subscribe] action=submit result=http-error status=${response.status}`);
    return { ok: false, reason: 'error' };
  } catch (err) {
    console.warn(
      `[subscribe] action=submit result=network-error message=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { ok: false, reason: 'error' };
  }
}
