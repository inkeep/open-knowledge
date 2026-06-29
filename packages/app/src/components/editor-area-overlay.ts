
interface OverlayDecisionInput {
  activeDocName: string | null;
  deferredActiveDocName: string | null;
  mountResolved: boolean;
  syncResolved: boolean;
}

export function shouldPaintOverlay(input: OverlayDecisionInput): boolean {
  const { activeDocName, deferredActiveDocName, mountResolved, syncResolved } = input;
  if (activeDocName === null) return false;
  if (activeDocName === deferredActiveDocName) return false;
  return !(mountResolved && syncResolved);
}
