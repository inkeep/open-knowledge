import { COMMENT_ACTIVE_FILL, COMMENT_HUE } from './anchor-layers';

const REVEAL_ATTR = 'data-comment-reveal';

function escapeAttr(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

export function findPropertyRow(key: string): HTMLElement | null {
  if (key === '') return null;
  return document.querySelector<HTMLElement>(
    `[data-testid="property-row"][data-key="${escapeAttr(key)}"]`,
  );
}

export function propertyRowRect(key: string): DOMRect | null {
  const row = findPropertyRow(key);
  if (row === null) return null;
  const rect = row.getBoundingClientRect();
  return rect.height === 0 && rect.width === 0 ? null : rect;
}

export function scrollPropertyRowIntoView(key: string): void {
  findPropertyRow(key)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function revealPropertyValueRange(args: {
  key: string;
  path: readonly (string | number)[];
  quote: string;
  start?: number;
  end?: number;
}): boolean {
  if (args.quote === '') return false;
  const lastStep = args.path.length === 0 ? args.key : args.path[args.path.length - 1];
  const preferred = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid="property-row"][data-key="${escapeAttr(String(lastStep))}"]`,
    ),
  );
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="property-row"]'));
  for (const row of [...preferred, ...all]) {
    const control = row.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input');
    if (control === null) continue;
    const range = locateInValue(control.value, args.quote, args.start, args.end);
    if (range === null) continue;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    control.focus();
    control.setSelectionRange(range.start, range.end);
    paintRevealSelection(control);
    return true;
  }
  return false;
}

export function locateInValue(
  value: string,
  quote: string,
  start?: number,
  end?: number,
): { start: number; end: number } | null {
  if (start !== undefined && end !== undefined && value.slice(start, end) === quote) {
    return { start, end };
  }
  const index = value.indexOf(quote);
  return index < 0 ? null : { start: index, end: index + quote.length };
}

function paintRevealSelection(control: HTMLTextAreaElement | HTMLInputElement): void {
  control.style.setProperty('--comment-reveal-fill', `rgba(${COMMENT_HUE},${COMMENT_ACTIVE_FILL})`);
  control.setAttribute(REVEAL_ATTR, 'true');
  const clear = () => {
    control.removeAttribute(REVEAL_ATTR);
    control.style.removeProperty('--comment-reveal-fill');
  };
  control.addEventListener('blur', clear, { once: true });
  control.addEventListener('pointerdown', clear, { once: true });
  control.addEventListener('keydown', clear, { once: true });
}
