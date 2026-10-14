let onScreen = false;

export function setDocPanelOnScreen(next: boolean): void {
  onScreen = next;
}

export function isDocPanelOnScreen(): boolean {
  return onScreen;
}
