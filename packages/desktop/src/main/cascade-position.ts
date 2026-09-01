export const CASCADE_OFFSET_PX = 28;

interface CascadeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CascadeInput {
  anchor: { x: number; y: number } | null;
  size: { width: number; height: number };
  workArea: CascadeRect;
}

export function cascadePosition(input: CascadeInput): { x: number; y: number } | null {
  const { anchor, size, workArea } = input;
  if (anchor === null) return null;

  const x = anchor.x + CASCADE_OFFSET_PX;
  const y = anchor.y + CASCADE_OFFSET_PX;
  const fitsRight = x + size.width <= workArea.x + workArea.width;
  const fitsBottom = y + size.height <= workArea.y + workArea.height;
  if (fitsRight && fitsBottom) return { x, y };

  return { x: workArea.x + CASCADE_OFFSET_PX, y: workArea.y + CASCADE_OFFSET_PX };
}
