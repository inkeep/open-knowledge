import type { HandoffOutcome } from '@inkeep/open-knowledge-core';

interface OpenExternalDeps {
  readonly okDesktop?: { shell: { openExternal(url: string): Promise<void> } };
  readonly doc?: Document;
}

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
