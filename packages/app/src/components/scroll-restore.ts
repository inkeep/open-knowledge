export type AnchorMeasurement =
  | { kind: 'measured'; contentPos: number }
  | { kind: 'unmeasurable' }
  | { kind: 'absent' };

export function measureAnchor(
  container: HTMLElement,
  anchor: HTMLElement | null | undefined,
): AnchorMeasurement {
  if (!anchor) return { kind: 'absent' };
  if (anchor.getClientRects().length === 0) return { kind: 'unmeasurable' };
  const cTop = container.getBoundingClientRect().top;
  const aTop = anchor.getBoundingClientRect().top;
  return { kind: 'measured', contentPos: aTop - cTop + container.scrollTop };
}

export function computeRestoreTarget(
  rawTarget: number,
  bodyOffset: number | null,
  anchor: AnchorMeasurement,
): number | null {
  if (bodyOffset === null) return rawTarget;
  switch (anchor.kind) {
    case 'measured':
      return anchor.contentPos + bodyOffset;
    case 'absent':
      return rawTarget;
    case 'unmeasurable':
      return null;
    default:
      return assertNever(anchor);
  }
}

const CONTENT_SURFACE_SELECTOR = '[contenteditable]';

export function measureContentExtent(container: HTMLElement): number | null {
  const containerTop = container.getBoundingClientRect().top;
  const { scrollTop } = container;
  let contentBottom: number | null = null;
  for (const surface of Array.from(container.querySelectorAll(CONTENT_SURFACE_SELECTOR))) {
    if (surface.parentElement?.closest(CONTENT_SURFACE_SELECTOR)) continue;
    if (surface.getClientRects().length === 0) continue;
    const bottom = surface.getBoundingClientRect().bottom - containerTop + scrollTop;
    if (contentBottom === null || bottom > contentBottom) contentBottom = bottom;
  }
  return contentBottom;
}

export function clampTargetToContent(
  target: number,
  contentBottom: number | null,
  clientHeight: number,
): number {
  if (contentBottom === null) return target;
  return Math.min(target, Math.max(0, contentBottom - clientHeight));
}

export function hasRestoreRunway(
  target: number,
  contentBottom: number | null,
  scrollHeight: number,
): boolean {
  return (contentBottom ?? scrollHeight) > target;
}

export function shouldRecordScrollPosition(anchor: AnchorMeasurement): boolean {
  switch (anchor.kind) {
    case 'measured':
    case 'absent':
      return true;
    case 'unmeasurable':
      return false;
    default:
      return assertNever(anchor);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled AnchorMeasurement variant: ${JSON.stringify(value)}`);
}

export const SCROLL_LANDING_TOLERANCE_PX = 1;

export function hasLandedAt(scrollTop: number, target: number): boolean {
  return Math.abs(scrollTop - target) <= SCROLL_LANDING_TOLERANCE_PX;
}

export function isExternalScroll(prevScrollTop: number, scrollTop: number): boolean {
  return scrollTop - prevScrollTop > SCROLL_LANDING_TOLERANCE_PX;
}

export const RESTORE_BACKSTOP_MS = 10_000;
