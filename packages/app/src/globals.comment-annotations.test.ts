import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const GLOBALS_CSS = resolve(dirname(fileURLToPath(import.meta.url)), 'globals.css');

function ruleBodiesFor(css: string, selector: string): string[] {
  const bodies: string[] = [];
  const pattern = new RegExp(`([^{}]*${selector.replace('.', '\\.')}[^{}]*)\\{([^}]*)\\}`, 'g');
  let match: RegExpExecArray | null = pattern.exec(css);
  while (match !== null) {
    bodies.push(match[2]);
    match = pattern.exec(css);
  }
  return bodies;
}

const HIDING_DECLARATION =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)|@apply\s[^;{}]*(?<=[\s:])(?:hidden|invisible)(?=\s|;|$)/i;

const ANNOTATION_SELECTORS = ['.comment-mark', '.comment-block'] as const;

describe('globals.css keeps comment annotations legible', () => {
  const css = readFileSync(GLOBALS_CSS, 'utf8');

  test.each(ANNOTATION_SELECTORS)('%s carries no rule that hides it', (selector) => {
    const bodies = ruleBodiesFor(css, selector);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((body) => HIDING_DECLARATION.test(body))).toEqual([]);
  });

  test.each(ANNOTATION_SELECTORS)('%s is dimmed via the muted-foreground token', (selector) => {
    const bodies = ruleBodiesFor(css, selector);
    expect(bodies.some((body) => /color\s*:\s*var\(--muted-foreground\)/.test(body))).toBe(true);
  });

  test.each([
    ['literal display', 'display: none;'],
    ['literal visibility', 'visibility: hidden;'],
    ['literal opacity', 'opacity: 0;'],
    ['utility display', '@apply hidden;'],
    ['utility visibility', '@apply invisible;'],
    ['utility among others', '@apply mt-2 hidden rounded-sm;'],
    ['utility behind a breakpoint variant', '@apply md:hidden;'],
    ['utility behind a theme variant', '@apply dark:invisible;'],
  ])('the hiding predicate fires on %s', (_label, declaration) => {
    expect(HIDING_DECLARATION.test(declaration)).toBe(true);
  });

  test.each([
    ['a fractional opacity', 'opacity: 0.6;'],
    ['an unrelated utility', '@apply mt-2 rounded-sm;'],
    ['a colour', 'color: var(--muted-foreground);'],
    ['an overflow rule', 'overflow: hidden;'],
    ['an overflow utility', '@apply overflow-hidden;'],
    ['a hyphenated utility ending in the token', '@apply scrollbar-hidden;'],
  ])('the hiding predicate does not fire on %s', (_label, declaration) => {
    expect(HIDING_DECLARATION.test(declaration)).toBe(false);
  });
});
