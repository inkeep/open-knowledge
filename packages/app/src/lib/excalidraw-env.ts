export {};

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

if (typeof window !== 'undefined' && window.EXCALIDRAW_ASSET_PATH === undefined) {
  window.EXCALIDRAW_ASSET_PATH =
    window.location.protocol === 'file:'
      ? new URL('excalidraw-assets/', window.location.href).href
      : '/excalidraw-assets/';
}
