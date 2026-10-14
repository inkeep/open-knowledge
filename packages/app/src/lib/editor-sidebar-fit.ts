export type EditorSidebar = 'files' | 'information';

export type EditorSidebarFit =
  | { mode: 'cover'; filesDocked: false; informationDocked: false }
  | { mode: 'both' | 'single'; filesDocked: boolean; informationDocked: boolean };

interface EditorSidebarFitInput {
  widthPx: number | null;
  filesWidthPx: number | null;
  informationWidthPx: number | null;
  documentMinimumPx: number;
  filesOpen: boolean;
  informationOpen: boolean;
  preferred: EditorSidebar | null;
}

export function resolveEditorSidebarFit({
  widthPx,
  filesWidthPx,
  informationWidthPx,
  documentMinimumPx,
  filesOpen,
  informationOpen,
  preferred,
}: EditorSidebarFitInput): EditorSidebarFit {
  const filesPresent = filesWidthPx != null;
  const informationPresent = informationWidthPx != null;
  const availablePx = widthPx == null ? Infinity : widthPx - documentMinimumPx;
  const filesRequiredPx = filesWidthPx ?? 0;
  const informationRequiredPx = informationPresent ? informationWidthPx + 1 : 0;
  if (availablePx < Math.max(filesRequiredPx, informationRequiredPx)) {
    return { mode: 'cover', filesDocked: false, informationDocked: false };
  }
  const filesWanted = filesPresent && filesOpen;
  const informationWanted = informationPresent && informationOpen;
  const bothFit = availablePx >= filesRequiredPx + informationRequiredPx;
  return {
    mode: bothFit ? 'both' : 'single',
    filesDocked: filesWanted && (bothFit || !informationWanted || preferred !== 'information'),
    informationDocked:
      informationWanted && (bothFit || !filesWanted || preferred === 'information'),
  };
}
