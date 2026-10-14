const EDITOR_HIDDEN_FOCUS_TARGETS = [
  '[data-nothing-open]',
  '[data-header-pane-button="editor"]',
] as const;

export function focusAwayFromHiddenEditor(): void {
  for (const selector of EDITOR_HIDDEN_FOCUS_TARGETS) {
    const target = document.querySelector<HTMLElement>(selector);
    if (target == null) continue;
    target.focus();
    if (document.activeElement === target) return;
  }
}

export function focusWaitsForEditor(): boolean {
  const active = document.activeElement;
  if (active == null || active === document.body) return true;
  return EDITOR_HIDDEN_FOCUS_TARGETS.some((selector) => active.closest(selector) != null);
}
