const pendingLinkEdits = new Set<string>();

export function setPendingLinkEdit(markId: string): void {
  pendingLinkEdits.add(markId);
}

export function consumePendingLinkEdit(markId: string): boolean {
  return pendingLinkEdits.delete(markId);
}

export function _resetPendingLinkEditForTest(): void {
  pendingLinkEdits.clear();
}
