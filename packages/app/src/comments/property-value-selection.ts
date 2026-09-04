const TEXT_CONTROL = /^(TEXTAREA|INPUT)$/;

function textControlInRow(trigger: HTMLElement): HTMLTextAreaElement | HTMLInputElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !TEXT_CONTROL.test(active.tagName)) return null;
  const row = trigger.closest('[data-testid="property-row"]');
  if (row === null || !row.contains(active)) return null;
  return active as HTMLTextAreaElement | HTMLInputElement;
}

export function capturePropertyValueSelection(trigger: HTMLElement): string | null {
  const control = textControlInRow(trigger);
  if (control === null) return null;
  const { selectionStart, selectionEnd } = control;
  if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) {
    return null;
  }
  const quote = control.value.slice(selectionStart, selectionEnd).trim();
  return quote === '' ? null : quote;
}
