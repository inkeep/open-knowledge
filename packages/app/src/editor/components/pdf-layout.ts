export type PdfLayoutMode = 'fit-width' | 'fit-height' | 'single' | 'two-odd' | 'two-even';

export interface PdfPageInfo {
  naturalWidth: number;
  naturalHeight: number;
}

const PAD_X = 24;
const PAD_Y = 24;

const TWO_PAGE_GUTTER = 12;

const MIN_SCALE = 0.1;

export function computeBaseScale(
  mode: PdfLayoutMode,
  page: PdfPageInfo,
  containerW: number,
  containerH: number,
): number {
  if (containerW <= 0 && (mode === 'fit-width' || mode === 'two-odd' || mode === 'two-even')) {
    return 1;
  }
  if (containerH <= 0 && mode === 'fit-height') return 1;

  switch (mode) {
    case 'fit-width':
      return Math.max(MIN_SCALE, (containerW - PAD_X) / page.naturalWidth);
    case 'fit-height':
      return Math.max(MIN_SCALE, (containerH - PAD_Y) / page.naturalHeight);
    case 'single':
      return 1;
    case 'two-odd':
    case 'two-even':
      return Math.max(MIN_SCALE, ((containerW - PAD_X) / 2 - TWO_PAGE_GUTTER) / page.naturalWidth);
  }
}
