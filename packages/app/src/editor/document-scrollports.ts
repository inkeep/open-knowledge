export const FULL_PAGE_CM_HOST_SELECTORS = {
  mermaidDocEditor: '[data-mermaid-doc-editor]',
  sourceEditor: '.source-editor',
  textDocEditor: '[data-text-doc-editor]',
} as const;

export const SCROLL_PIN_SLACK_PX = 40;

export const DOCUMENT_SCROLL_HOST_CLASS = 'editor-doc-scroll';

export const DOCUMENT_SCROLL_HOST_SELECTOR = `.${DOCUMENT_SCROLL_HOST_CLASS}`;

export const CONFLICT_SCROLLPORT_SELECTOR = '.conflict-view';

export const DOCUMENT_SCROLLPORT_SELECTORS = [
  DOCUMENT_SCROLL_HOST_SELECTOR,
  CONFLICT_SCROLLPORT_SELECTOR,
  `${FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor} .cm-scroller`,
  `${FULL_PAGE_CM_HOST_SELECTORS.textDocEditor} .cm-scroller`,
] as const;

const DOCUMENT_SCROLLPORT_SELECTOR = DOCUMENT_SCROLLPORT_SELECTORS.join(', ');

export function documentScrollports(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(DOCUMENT_SCROLLPORT_SELECTOR)];
}

export function isPinnedToEnd(el: HTMLElement): boolean {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 && el.scrollTop >= max - SCROLL_PIN_SLACK_PX;
}
