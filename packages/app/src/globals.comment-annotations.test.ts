/**
 * globals.css — comment annotations must stay legible.
 *
 * Comment annotations used to be hidden by an inline `display: none` in the PM
 * binding, which the schema class guard in
 * `tests/dom/promoter-claimed-text-visibility.dom.test.tsx` covers. Once that
 * style moved out of the schema, this stylesheet became the thing that decides
 * whether a promoted run is legible — and jsdom loads no stylesheet, so a
 * `.comment-mark { display: none }` regression would restore the original bug
 * with the whole suite green.
 *
 * Reading the stylesheet as data is the sibling `globals.*.test.ts` pattern.
 * The check covers both spellings of hiding that reach this file: the literal
 * declarations and the Tailwind utility form, since `@apply hidden` compiles
 * to `display: none` and this stylesheet uses `@apply` throughout.
 *
 * It is a text-level check, not a computed-style one — it cannot see cascade,
 * specificity, or an ancestor that hides the subtree. The Playwright case in
 * `tests/stress/comment-annotation-visibility.e2e.ts` reads `getComputedStyle`
 * against the compiled stylesheet and dominates this one; this stays as the
 * deterministic tier that runs on every unit invocation.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const GLOBALS_CSS = resolve(dirname(fileURLToPath(import.meta.url)), 'globals.css');

/** Declaration bodies of every rule whose selector list mentions `selector`. */
function ruleBodiesFor(css: string, selector: string): string[] {
  const bodies: string[] = [];
  // Selector lists span lines and carry pseudo-elements / attribute
  // qualifiers, so match up to the opening brace rather than assume a shape.
  const pattern = new RegExp(`([^{}]*${selector.replace('.', '\\.')}[^{}]*)\\{([^}]*)\\}`, 'g');
  let match: RegExpExecArray | null = pattern.exec(css);
  while (match !== null) {
    bodies.push(match[2]);
    match = pattern.exec(css);
  }
  return bodies;
}

/**
 * Both spellings of "this element is not rendered". The utility arm matters as
 * much as the literal one: `@apply hidden` and `@apply invisible` compile to
 * `display: none` and `visibility: hidden`, and leave no literal token in the
 * source for the first arm to catch.
 *
 * The utility name has to start a token, hence the lookbehind rather than a
 * word boundary: `\b` treats `-` as a boundary, so it would report
 * `@apply overflow-hidden` as a hiding rule. A variant prefix separator is
 * admitted alongside whitespace so `@apply md:hidden` still counts.
 */
const HIDING_DECLARATION =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)|@apply\s[^;{}]*(?<=[\s:])(?:hidden|invisible)(?=\s|;|$)/i;

const ANNOTATION_SELECTORS = ['.comment-mark', '.comment-block'] as const;

describe('globals.css keeps comment annotations legible', () => {
  const css = readFileSync(GLOBALS_CSS, 'utf8');

  test.each(ANNOTATION_SELECTORS)('%s carries no rule that hides it', (selector) => {
    const bodies = ruleBodiesFor(css, selector);
    // Non-vacuity: the selector has to actually be styled, or this would pass
    // on a stylesheet that never mentions it.
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((body) => HIDING_DECLARATION.test(body))).toEqual([]);
  });

  test.each(ANNOTATION_SELECTORS)('%s is dimmed via the muted-foreground token', (selector) => {
    const bodies = ruleBodiesFor(css, selector);
    expect(bodies.some((body) => /color\s*:\s*var\(--muted-foreground\)/.test(body))).toBe(true);
  });

  // The predicate is the whole guard, so it gets its own fixtures rather than
  // resting on the stylesheet happening to contain each shape today.
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
