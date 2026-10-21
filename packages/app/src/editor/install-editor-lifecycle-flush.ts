export const RESUME_THROTTLE_MS = 1_000;

export interface EditorLifecycleFlushDeps {
  onHide: () => void;
  onVisible: () => void;
  onResume?: () => void;
  now?: () => number;
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
  let lastResumeAt = Number.NEGATIVE_INFINITY;
  const now = deps.now ?? Date.now;
  const fireResume = (): void => {
    if (deps.onResume === undefined) return;
    const at = now();
    if (at - lastResumeAt < RESUME_THROTTLE_MS) return;
    lastResumeAt = at;
    deps.onResume();
  };
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
      fireResume();
    }
  };
  const onFocus = (): void => {
    if (doc.visibilityState === 'visible') fireResume();
  };

  win.addEventListener('pagehide', onPageHide as (event: Event) => void);
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibility);

  return () => {
    win.removeEventListener('pagehide', onPageHide as (event: Event) => void);
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
