export interface MeasuredBox {
  readonly width: number;
  readonly height: number;
}

export interface ResizeNotification {
  readonly contentRect?: MeasuredBox | null;
}

export function isRenderedBox(box: MeasuredBox | null | undefined): boolean {
  if (box == null) return false;
  const { width, height } = box;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

export function shouldFitForResize(entries?: readonly ResizeNotification[] | null): boolean {
  if (entries == null || entries.length === 0) return false;
  return entries.some((entry) => isRenderedBox(entry.contentRect));
}

export interface ComputedBox {
  readonly width: string;
  readonly height: string;
}

export function isRenderedContainer(
  rect: MeasuredBox | null | undefined,
  computed: ComputedBox | null | undefined,
): boolean {
  if (!isRenderedBox(rect)) return false;
  if (computed == null) return false;
  return isRenderedBox({
    width: Number.parseFloat(computed.width),
    height: Number.parseFloat(computed.height),
  });
}
