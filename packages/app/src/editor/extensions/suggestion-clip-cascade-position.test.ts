/**
 * Cascade-position pin for the suggestion picker's shrink-propagation rule.
 *
 * The rule makes a pane-clipped popup's content yield to the `max-width` the
 * positioning pass writes on the wrapper. Whether it is a CEILING (a cap for
 * descendants that state nothing, overridable by one that states its own) or a
 * FLOOR (unconditionally overriding every author cap) is decided entirely by
 * its LAYER: the cascade sorts layer before specificity, unlayered author
 * declarations form an implicit final layer above every named one, and
 * Tailwind emits its utilities into `@layer utilities`. Unlayered, the rule
 * beats every `max-w-*` no matter how weak its selector — which is what it did
 * for two commits, while a comment claimed the opposite.
 *
 * Source text, deliberately. No runtime tier can reach this: jsdom has no
 * layout (`tests/dom/jsdom-preload.ts`), and the Playwright geometry specs
 * cannot discriminate a ceiling from a floor because no picker today carries a
 * descendant cap narrower than `100%` — the discriminating case is the future
 * one the rule exists to serve. CLAUDE.md's "never assert raw source text" is
 * scoped to React component tests and carves out exactly this: a property
 * whose runtime coverage is impossible. `comment-hue-contrast.test.ts` and
 * `build/chrome-tokens-vite-plugin.test.ts` read this same stylesheet the same
 * way.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const GLOBALS_CSS = resolve(dirname(fileURLToPath(import.meta.url)), '../../globals.css');

/** The shrink-propagation rule's selector, as written. */
const SHRINK_SELECTOR = '[data-suggestion-popup][data-suggestion-clipped] *';

/**
 * Tailwind v4 expands `@import "tailwindcss"` to
 * `@layer theme, base, components, utilities`. Anything the rule shares a
 * layer with, or that sits in a LATER layer, can override it; anything earlier
 * cannot. `utilities` is where every `max-w-*` lands, so the rule has to be
 * strictly before it.
 */
const LAYERS_BEFORE_UTILITIES = ['theme', 'base', 'components'];

/** The `@layer <name> {` block containing `needle`, or null if unlayered. */
function enclosingLayer(css: string, needle: string): string | null {
  const target = css.indexOf(needle);
  if (target === -1) throw new Error(`cascade-position: ${needle} not found in globals.css`);
  const opener = /@layer\s+([a-zA-Z0-9_-]+)\s*\{/g;
  let enclosing: string | null = null;
  for (let match = opener.exec(css); match !== null; match = opener.exec(css)) {
    if (match.index > target) break;
    // Walk braces from this opener to find where the block ends. A block that
    // closes before the target does not contain it.
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (let i = end; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > target) enclosing = match[1] ?? null;
  }
  return enclosing;
}

describe('suggestion picker shrink rule cascade position', () => {
  test('sits in a layer that Tailwind utilities can override', () => {
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    const layer = enclosingLayer(css, SHRINK_SELECTOR);
    expect(
      layer,
      'the shrink rule is unlayered, which makes it a FLOOR: unlayered author ' +
        'declarations outrank every named layer, so it would beat any max-w-* a ' +
        'picker descendant states, whatever the selector specificity',
    ).not.toBeNull();
    expect(
      LAYERS_BEFORE_UTILITIES,
      `the shrink rule is in @layer ${layer}, which does not sort before Tailwind's ` +
        '@layer utilities',
    ).toContain(layer);
  });

  test('the helper actually detects an unlayered rule', () => {
    // Mutation guard: without this, a helper that returned a layer name
    // unconditionally would keep the assertion above green forever.
    expect(enclosingLayer('.a { color: red }\n.target { x: 1 }', '.target')).toBeNull();
  });

  test('the helper does not credit a layer block that closed earlier', () => {
    const css = '@layer base {\n  .a { color: red }\n}\n.target { x: 1 }';
    expect(enclosingLayer(css, '.target')).toBeNull();
  });
});
