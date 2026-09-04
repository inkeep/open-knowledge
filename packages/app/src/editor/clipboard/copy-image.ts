interface DesktopClipboardBridge {
  copyImage(params: { readonly src: string; readonly alt: string }): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: 'fetch-failed' | 'path-escape' | 'empty-image' | 'read-error' | 'write-error';
        detail?: string;
      }
  >;
}

function getDesktopClipboard(): DesktopClipboardBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { okDesktop?: { clipboard?: unknown } }).okDesktop;
  const c = bridge?.clipboard as { copyImage?: unknown } | undefined;
  if (!c || typeof c.copyImage !== 'function') return null;
  return c as DesktopClipboardBridge;
}

let installed = false;
if (typeof window !== 'undefined' && !installed) {
  installed = true;
  document.addEventListener('copy', onDocCopy, true);
}

function onDocCopy(ev: ClipboardEvent): void {
  const target = ev.target;
  if (!(target instanceof HTMLImageElement)) return;
  if (!target.closest('.ProseMirror')) return;
  const resolvedSrc = target.currentSrc || target.src;
  if (!resolvedSrc) return;
  const alt = target.getAttribute('alt') ?? '';
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const bridge = getDesktopClipboard();
  if (bridge) {
    void bridge
      .copyImage({ src: resolvedSrc, alt })
      .then((res) => {
        if (res.ok) return;
        console.warn('[copy-image] desktop write declined, falling back', res.reason, res.detail);
        void webCopyFromImgEl(alt, resolvedSrc);
      })
      .catch((err) => {
        console.warn('[copy-image] desktop bridge threw, falling back', err);
        void webCopyFromImgEl(alt, resolvedSrc);
      });
    return;
  }
  void webCopyFromImgEl(alt, resolvedSrc);
}

async function webCopyFromImgEl(alt: string, resolvedSrc: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write) {
    console.warn('[copy-image] navigator.clipboard.write unavailable — skipping web fallback');
    return;
  }
  const html = `<img src="${escapeAttr(resolvedSrc)}" alt="${escapeAttr(alt)}">`;
  const escapedAlt = alt.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
  const escapedSrc = resolvedSrc.replaceAll('(', '%28').replaceAll(')', '%29');
  const markdown = `![${escapedAlt}](${escapedSrc})`;
  try {
    const blob = await fetch(resolvedSrc, { signal: AbortSignal.timeout(10_000) }).then(
      async (res) => {
        if (!res.ok) throw new Error(`copy-image fetch failed: ${res.status}`);
        const b = await res.blob();
        return b.type === 'image/png' ? b : new Blob([b], { type: 'image/png' });
      },
    );
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob,
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
  } catch (err) {
    console.warn('[copy-image] web clipboard write failed', err);
  }
}

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
