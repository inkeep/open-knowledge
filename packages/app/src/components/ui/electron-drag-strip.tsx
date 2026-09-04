const DRAG_BAND_HEIGHT = 'h-12';

const DRAG_BAND_CLEARANCE = 'max-h-[calc(100dvh-6rem)]';

function isElectronHost() {
  return typeof window !== 'undefined' && window.okDesktop != null;
}

export function electronDragBandClearance(): string | undefined {
  return isElectronHost() ? DRAG_BAND_CLEARANCE : undefined;
}

export function ElectronDragStrip({ testId }: { testId: string }) {
  if (!isElectronHost()) return null;

  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      data-electron-drag=""
      className={`pointer-events-none fixed inset-x-0 top-0 z-50 ${DRAG_BAND_HEIGHT} [-webkit-app-region:drag]`}
    />
  );
}
