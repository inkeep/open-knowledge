export interface DocumentTeardownDeps {
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    readonly visibilityState: DocumentVisibilityState;
  };
}

export interface DocumentTeardownObserver {
  isUnloading: () => boolean;
  uninstall: () => void;
}

export function installDocumentTeardownObserver(
  deps: DocumentTeardownDeps = {},
): DocumentTeardownObserver {
  const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (win === undefined || doc === undefined) {
    return { isUnloading: () => false, uninstall: () => {} };
  }

  let unloading = false;
  const onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted === false) unloading = true;
  };
  const onPageShow = (): void => {
    unloading = false;
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') unloading = false;
  };

  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    isUnloading: () => unloading,
    uninstall() {
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
