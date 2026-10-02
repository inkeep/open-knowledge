import type { CopyImageRequest, CopyImageResult } from '@inkeep/open-knowledge-core/desktop-bridge';

export type CopyImageOutcome =
  | { ok: true; via: 'desktop' | 'browser'; desktopFailure?: CopyImageDesktopFailure }
  | {
      ok: false;
      reason: 'clipboard-unavailable' | 'fetch-failed' | 'write-error';
      detail: string;
      desktopFailure?: CopyImageDesktopFailure;
    };

type CopyImageDesktopFailure =
  | Extract<CopyImageResult, { ok: false }>
  | { ok: false; reason: 'bridge-threw'; detail: string };

export interface CopyImageEnv {
  readonly desktopCopyImage: ((request: CopyImageRequest) => Promise<CopyImageResult>) | null;
  readonly writeClipboard: ((items: ClipboardItem[]) => Promise<void>) | null;
  readonly createClipboardItem: (items: Record<string, Blob>) => ClipboardItem;
  readonly fetch: typeof fetch;
}

export async function copyImage(
  request: CopyImageRequest,
  env: CopyImageEnv = browserCopyImageEnv(),
): Promise<CopyImageOutcome> {
  let desktopFailure: CopyImageDesktopFailure | undefined;
  if (env.desktopCopyImage) {
    try {
      const result = await env.desktopCopyImage(request);
      if (result.ok) return { ok: true, via: 'desktop' };
      desktopFailure = result;
    } catch (err) {
      desktopFailure = { ok: false, reason: 'bridge-threw', detail: errorMessage(err) };
    }
  }
  const outcome = await copyImageInBrowser(request, env);
  return desktopFailure ? { ...outcome, desktopFailure } : outcome;
}

async function copyImageInBrowser(
  request: CopyImageRequest,
  env: CopyImageEnv,
): Promise<CopyImageOutcome> {
  if (!env.writeClipboard) {
    return {
      ok: false,
      reason: 'clipboard-unavailable',
      detail: 'navigator.clipboard.write unavailable',
    };
  }
  let png: Blob;
  try {
    const res = await env.fetch(request.src, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: 'fetch-failed', detail: `HTTP ${res.status}` };
    const fetched = await res.blob();
    png = fetched.type === 'image/png' ? fetched : new Blob([fetched], { type: 'image/png' });
  } catch (err) {
    return { ok: false, reason: 'fetch-failed', detail: errorMessage(err) };
  }
  try {
    await env.writeClipboard([env.createClipboardItem({ 'image/png': png })]);
  } catch (err) {
    return { ok: false, reason: 'write-error', detail: errorMessage(err) };
  }
  return { ok: true, via: 'browser' };
}

function browserCopyImageEnv(): CopyImageEnv {
  const desktop = typeof window === 'undefined' ? undefined : window.okDesktop?.clipboard;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return {
    desktopCopyImage: desktop ? (request) => desktop.copyImage(request) : null,
    writeClipboard: clipboard?.write ? (items) => clipboard.write(items) : null,
    createClipboardItem: (items) => new ClipboardItem(items),
    fetch: (input, init) => fetch(input, init),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
