interface VerticalExtent {
  top: number;
  bottom: number;
}

export function changedRangeIsOnScreen(range: VerticalExtent, region: VerticalExtent): boolean {
  if (!Number.isFinite(range.top) || !Number.isFinite(range.bottom)) return true;
  return range.bottom > region.top && range.top < region.bottom;
}
