import { describe, expect, test } from 'vitest';
import { blankComments, readGlobalsCssRaw } from './globals-css.test-helper';

const SHRINK_SELECTOR = '[data-suggestion-popup][data-suggestion-clipped] *';

const LAYERS_BEFORE_UTILITIES = ['theme', 'base', 'components'];

function enclosingLayer(source: string, selector: string): string | null {
  const css = blankComments(source);
  const prelude = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const found = prelude.exec(css);
  if (!found) throw new Error(`cascade-position: no rule with prelude ${selector} in globals.css`);
  const target = found.index;
  const opener = /@layer\s+([a-zA-Z0-9_-]+)\s*\{/g;
  let enclosing: string | null = null;
  for (let match = opener.exec(css); match !== null; match = opener.exec(css)) {
    if (match.index > target) break;
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
    const css = readGlobalsCssRaw();
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
    expect(enclosingLayer('.a { color: red }\n.target { x: 1 }', '.target')).toBeNull();
  });

  test('the helper does not credit a layer block that closed earlier', () => {
    const css = '@layer base {\n  .a { color: red }\n}\n.target { x: 1 }';
    expect(enclosingLayer(css, '.target')).toBeNull();
  });

  test('the helper ignores the selector quoted in a comment', () => {
    const css = '@layer base {\n  /* .target is capped elsewhere */\n}\n.target { x: 1 }';
    expect(enclosingLayer(css, '.target')).toBeNull();
  });

  test('the helper ignores a quoted selector that carries its own brace', () => {
    const css = '@layer base {\n  /* .target { x: 1 } is set below */\n}\n.target { x: 1 }';
    expect(enclosingLayer(css, '.target')).toBeNull();
  });
});
