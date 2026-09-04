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
