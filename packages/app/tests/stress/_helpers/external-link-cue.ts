import type { Page } from '@playwright/test';

export interface ExternalLinkCue {
  text: string;
  afterContent: string;
}

export function hasExternalCue(afterContent: string): boolean {
  return !['none', 'normal', '""', "''"].includes(afterContent);
}

export async function externalLinkCueSnapshot(page: Page, scope = ''): Promise<ExternalLinkCue[]> {
  return page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => ({
        text: element.textContent ?? '',
        afterContent: window.getComputedStyle(element, '::after').content,
      })),
    `.ProseMirror ${scope} [data-resolution-state="external"]`,
  );
}
