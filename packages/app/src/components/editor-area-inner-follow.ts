import type { Layout } from 'react-resizable-panels';
import { computeStickyRepinLayout } from './editor-area-sticky-repin';

interface InnerFollowParams {
  readonly outerLayout: Layout;
  readonly outerResidualId: string;
  readonly outerPanelSpacePx: number;
  readonly innerChromePx: number;
  readonly innerLayout: Layout;
  readonly innerResidualId: string;
  readonly pinnedPx: Record<string, number>;
}

export function predictInnerPanelSpacePx({
  outerLayout,
  outerResidualId,
  outerPanelSpacePx,
  innerChromePx,
}: Pick<
  InnerFollowParams,
  'outerLayout' | 'outerResidualId' | 'outerPanelSpacePx' | 'innerChromePx'
>): number | null {
  const residualPct = outerLayout[outerResidualId];
  if (residualPct == null || outerPanelSpacePx <= 0) return null;
  const innerPx = (residualPct / 100) * outerPanelSpacePx - innerChromePx;
  return innerPx > 0 ? innerPx : null;
}

export function computeInnerFollowLayout(params: InnerFollowParams): Layout {
  const innerPx = predictInnerPanelSpacePx(params);
  if (innerPx == null) return params.innerLayout;
  return computeStickyRepinLayout({
    currentLayout: params.innerLayout,
    containerPx: innerPx,
    pinnedPx: params.pinnedPx,
    residualId: params.innerResidualId,
  });
}
