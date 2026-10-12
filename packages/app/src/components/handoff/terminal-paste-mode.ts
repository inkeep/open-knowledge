const bracketedPasteProbes = new Map<string, () => boolean>();

export function registerBracketedPasteProbe(ptyId: string, probe: () => boolean): () => void {
  bracketedPasteProbes.set(ptyId, probe);
  return () => {
    if (bracketedPasteProbes.get(ptyId) === probe) bracketedPasteProbes.delete(ptyId);
  };
}

export function isBracketedPasteEnabled(ptyId: string): boolean {
  return bracketedPasteProbes.get(ptyId)?.() === true;
}
