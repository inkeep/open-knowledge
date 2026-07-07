/**
 * Host-aware `openExternal` wrapper — single choke point for the Open-in-Agent
 * dispatch path. Electron host forwards to `window.okDesktop.shell.openExternal`
 * (main-process runs the scheme allowlist check). Web host uses an anchor
 * element with `.click()` — the most reliable non-http scheme dispatch in
 * browsers; avoids the "Allow this site to open X?" interstitial that
 * `window.location.href` triggers.
 */

import type { HandoffOutcome } from '@inkeep/open-knowledge-core';

interface OpenExternalDeps {
  /** Populated by the Electron preload. `undefined` on web / CLI. */
  readonly okDesktop?: { shell: { openExternal(url: string): Promise<void> } };
  /** DOM anchor-click primitive (web host). Defaults to `document`. */
  readonly doc?: Document;
}

/**
 * Dispatch an outbound URL via the host's preferred primitive. Pure of React.
 *
 * The web-host code path requires a DOM; in SSR / Node contexts without
 * `document`, the call resolves to `{ ok: false, reason: 'dispatch-error',
 * detail: 'no DOM available' }` rather than throwing — matches the
 * conservative-failure posture of the rest of the handoff pipeline.
 */
export async function openExternal(
  url: string,
  deps: OpenExternalDeps = {},
): Promise<HandoffOutcome> {
  const okDesktop =
    deps.okDesktop ?? (typeof window !== 'undefined' ? window.okDesktop : undefined);

  if (okDesktop?.shell?.openExternal) {
    try {
      await okDesktop.shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'dispatch-error', detail: errorDetail(err) };
    }
  }

  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) {
    return { ok: false, reason: 'dispatch-error', detail: 'no DOM available' };
  }
  try {
    const a = doc.createElement('a');
    a.href = url;
    a.rel = 'noopener noreferrer';
    // http(s) URLs are the web-fallback path — without `target="_blank"` the
    // anchor click navigates the editor tab away. Custom schemes are
    // intercepted by the OS scheme handler and don't navigate the tab;
    // leaving `target` unset avoids the browser interstitial prompt.
    if (/^https?:/i.test(url)) {
      a.target = '_blank';
    }
    doc.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'dispatch-error', detail: errorDetail(err) };
  }
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
