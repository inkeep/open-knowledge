/**
 * Cmd+C on an image inside the editor — replace PM's default copy
 * output (HTML `<img>` + alt-text as plain) with what a macOS system
 * screenshot writes: the 9-flavor raster set that every rich receiver
 * (Notes, Docs, Slack chat, Notion inline, iMessage) picks up first-
 * try.
 *
 * The intercept runs in a document-level `copy` capture-phase listener,
 * NOT the natural PM `handleDOMEvents.copy` plugin surface. That surface
 * never received events for image node selections in Electron — the copy
 * bubbled from the `<img>` up through the editor DOM but PM's plugin
 * chain didn't see it (the failure is opaque; suspect
 * react-medium-image-zoom's Zoom wrapper interacting with PM's synthetic
 * `document.execCommand('copy')` dispatch for NodeSelections). A doc-
 * level capture-phase listener catches every copy regardless of the
 * plugin chain's state.
 *
 * The clipboard write itself runs in Electron main via
 * `window.okDesktop.clipboard.copyImage`, because renderer's
 * `navigator.clipboard.write` cannot produce the 9-flavor raster set —
 * Chromium's Async Clipboard API only accepts a single `image/png`
 * blob. Main's `nativeImage`-backed write goes through NSImage, which
 * macOS's pasteboard writer expands into every raster flavor a receiver
 * might read.
 */

/**
 * Local duck type for the desktop-bridge copy surface. Structurally
 * matches `OkDesktopBridge['clipboard']['copyImage']` in
 * `packages/core/src/desktop-bridge.ts` — kept local instead of
 * importing the full bridge type so this module stays testable without
 * dragging the whole bridge surface into the test env. Adding a reason
 * to the union here + in the bridge/IPC types is the sync contract.
 */
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

/** Read the desktop-bridge copy surface off `window.okDesktop.clipboard`, or null on web. */
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
  // Strict IMG-target match. PM dispatches copy events on the selected
  // node's DOM element — for a NodeSelection on an image, that IS the
  // `<img>`. A container target (paragraph, ProseMirror root) means a
  // broader selection (multi-block, select-all, text-with-inline-img)
  // that we must NOT hijack — otherwise the intercept below replaces
  // the user's rich copy with just image bytes.
  if (!(target instanceof HTMLImageElement)) return;
  if (!target.closest('.ProseMirror')) return;
  const resolvedSrc = target.currentSrc || target.src;
  if (!resolvedSrc) return;
  const alt = target.getAttribute('alt') ?? '';
  // `stopImmediatePropagation` prevents PM's own copy handler on
  // `view.dom` from running after ours. `preventDefault` alone only
  // cancels the browser's default action; PM's listener still fires
  // during the bubble phase and would `data.setData('text/html', …)` +
  // `data.setData('text/plain', …)` synchronously, committing at end
  // of event dispatch and racing with our async main-process write.
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const bridge = getDesktopClipboard();
  if (bridge) {
    void bridge
      .copyImage({ src: resolvedSrc, alt })
      .then((res) => {
        if (res.ok) return;
        // Main returned a classifiable failure (`empty-image` for a
        // WebP/GIF/AVIF nativeImage can't decode; `fetch-failed` for
        // an unreachable external URL; `path-escape` / `read-error`
        // for same-origin misses). Fall back to the web write so the
        // clipboard isn't left empty — Chromium's single-blob
        // limitation still leaves the receiver with something.
        console.warn('[copy-image] desktop write declined, falling back', res.reason, res.detail);
        void webCopyFromImgEl(alt, resolvedSrc);
      })
      .catch((err) => {
        console.warn('[copy-image] desktop bridge threw, falling back', err);
        void webCopyFromImgEl(alt, resolvedSrc);
      });
    return;
  }
  // Pure-browser hosts (no desktop bridge). Chromium's Async Clipboard
  // API only accepts one image flavor at a time, so this write is
  // strictly less rich than the Electron path (single `image/png` vs
  // main's 9-flavor raster set). Kept so browser hosts still get
  // *some* raster on the clipboard instead of PM's alt-text default.
  void webCopyFromImgEl(alt, resolvedSrc);
}

async function webCopyFromImgEl(alt: string, resolvedSrc: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write) {
    // Every other failure path in this module logs — the doc-level
    // listener has already preventDefaulted + stopImmediatePropagation-ed
    // by the time we're here, so a silent early return leaves Cmd+C as
    // a no-op with zero diagnostic trail. Electron always ships this
    // API, so the branch only fires on pure-browser hosts where the
    // Async Clipboard API is missing or restricted.
    console.warn('[copy-image] navigator.clipboard.write unavailable — skipping web fallback');
    return;
  }
  const html = `<img src="${escapeAttr(resolvedSrc)}" alt="${escapeAttr(alt)}">`;
  // CommonMark image syntax: `[` / `]` in alt closes the label early,
  // and `(` / `)` in the URL closes the destination — escape both so
  // a paste into a markdown editor round-trips as a single image.
  const escapedAlt = alt.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
  const escapedSrc = resolvedSrc.replaceAll('(', '%28').replaceAll(')', '%29');
  const markdown = `![${escapedAlt}](${escapedSrc})`;
  try {
    // Match the main-process fetch timeout (10s in
    // copy-image-clipboard.ts). Otherwise a slow external image
    // hangs the clipboard write indefinitely — and when the desktop
    // path times out first and we fall through here, the user waits
    // another 10s+ on the same slow URL.
    const blob = await fetch(resolvedSrc, { signal: AbortSignal.timeout(10_000) }).then(
      async (res) => {
        if (!res.ok) throw new Error(`copy-image fetch failed: ${res.status}`);
        const b = await res.blob();
        // Chromium's Async Clipboard API only accepts `image/png` on
        // write — a `ClipboardItem({ 'image/jpeg': blob })` throws
        // `DOMException: Type image/jpeg not supported`. Always coerce
        // to `image/png` here; most receivers sniff the bytes and
        // ignore the declared MIME anyway.
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
