export function groupHeadingFor(el: Element | null | undefined): HTMLElement | null {
  return el?.closest('section')?.querySelector<HTMLElement>('h4') ?? null;
}
