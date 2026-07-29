/**
 * Attach the tab-lifecycle listeners that drive background flush / resync.
 *
 * Mirrors the client-log-forwarder's hide handling: listen on BOTH `pagehide`
 * (fires on real unload/bfcache where `visibilitychange` may not) and
 * `visibilitychange → hidden`, and fire `onVisible` when the tab returns. The
 * `win`/`doc` are injectable so the unit test can emit synthetic events without
 * jsdom; production falls back to the real globals.
 *
 * The two listeners overlap: closing a tab fires `visibilitychange → hidden`
 * AND THEN `pagehide`, so a naive fan-out runs the hide work twice per real
 * close (two `forceSync()`s and two concurrent full-state IDB flushes per open
 * doc). `onHide` is therefore edge-triggered — once per hidden transition,
 * re-armed by the next `visible` (which is also what a bfcache restore
 * delivers, so a restored page hides again normally).
 */
export interface EditorLifecycleFlushDeps {
  onHide: () => void;
  onVisible: () => void;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    readonly visibilityState: DocumentVisibilityState;
  };
}

export function installEditorLifecycleFlush(deps: EditorLifecycleFlushDeps): () => void {
  const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (win === undefined || doc === undefined) return () => {};

  let hidden = false;
  const fireHide = (): void => {
    if (hidden) return;
    hidden = true;
    deps.onHide();
  };

  const onPageHide = (): void => fireHide();
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') fireHide();
    else if (doc.visibilityState === 'visible') {
      hidden = false;
      deps.onVisible();
    }
  };

  win.addEventListener('pagehide', onPageHide as (event: Event) => void);
  doc.addEventListener('visibilitychange', onVisibility);

  return () => {
    win.removeEventListener('pagehide', onPageHide as (event: Event) => void);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
