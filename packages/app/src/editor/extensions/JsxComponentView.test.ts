/**
 * Regression tests for `extractPrimitiveProps` (JsxComponentView.tsx).
 *
 * The function's contract:
 *   - Passes through every declared non-reactnode prop.
 *   - Excludes prop names the descriptor marked as `reactnode`.
 *   - Preserves unknown attrs (merge symmetry — fumadocs components
 *     often require attrs we don't declare, e.g. `InlineTOC.items`).
 *   - Routes every return value through `sanitizeComponentProps` — XSS
 *     denylist (`dangerouslySetInnerHTML`, `on*` events, React internals),
 *     URL-scheme allowlist, style sanitization, nested URL traversal.
 *
 * the implementation iterated ONLY the descriptor-declared
 * PropDef entries, dropping any attr not in the registry. Example crash:
 * `<InlineTOC items={[...]}>` → fumadocs InlineTOC does `items.map(...)`
 * → `TypeError: Cannot read properties of undefined (reading 'map')`
 * because the `items` attr was silently dropped.
 *
 * Also includes the kind-discriminator write-boundary helper. Expression-kind
 * jsxComponent nodes are sourceRaw-only and must not receive element-shaped
 * prop edits.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPrimitiveProps, getElementJsxAttrs, stableHash } from './JsxComponentView.tsx';

/** Test helper: build a `ReadonlySet<string>` of reactnode-typed prop names.
 *  (In production the descriptor registry pre-computes this once at build
 *  time — see `packages/app/src/editor/registry/index.ts`.) */
function reactNodes(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

describe('extractPrimitiveProps', () => {
  test('passes through declared non-reactnode props', () => {
    const attrs = { props: { type: 'warning', title: 'Heads up' } };
    const result = extractPrimitiveProps(attrs, reactNodes());
    expect(result).toEqual({ type: 'warning', title: 'Heads up' });
  });

  test('excludes reactnode-typed prop names (content holes are NOT render-time props)', () => {
    // Shouldn't happen in practice (parser wouldn't put children in props),
    // but asserting the filter excludes reactnode names if they somehow
    // appear.
    const attrs = { props: { title: 'Hi', children: 'shouldnt be here' } };
    const result = extractPrimitiveProps(attrs, reactNodes('children'));
    expect(result).toEqual({ title: 'Hi' });
    expect(result).not.toHaveProperty('children');
  });

  test('REGRESSION: undeclared attrs pass through (e.g. InlineTOC items, TypeTable type)', () => {
    // Registry PropDef only declares `children: reactnode`, but fumadocs
    // InlineTOC requires an `items` array or it crashes.
    const attrs = {
      props: {
        items: [
          { title: 'Intro', url: '#intro', depth: 1 },
          { title: 'Usage', url: '#usage', depth: 2 },
        ],
      },
    };
    const result = extractPrimitiveProps(attrs, reactNodes('children'));

    // The undeclared `items` MUST reach the component.
    expect(result).toHaveProperty('items');
    expect(Array.isArray(result.items)).toBe(true);
    expect((result.items as unknown[]).length).toBe(2);
  });

  test('REGRESSION: preserves unknown attrs alongside declared ones (FR-21 merge symmetry)', () => {
    // fumadocs Card has `title`/`description`/`color`/`external` attrs; if
    // the descriptor only declares title+description, color/external must
    // still reach the rendered component.
    const attrs = {
      props: {
        title: 'Custom Card',
        description: 'With extras',
        color: '#F05032',
        external: true,
      },
    };
    const result = extractPrimitiveProps(attrs, reactNodes());
    expect(result).toEqual({
      title: 'Custom Card',
      description: 'With extras',
      color: '#F05032',
      external: true,
    });
  });

  test('handles empty props', () => {
    const result = extractPrimitiveProps({ props: {} }, reactNodes());
    expect(result).toEqual({});
  });

  test('handles missing props attr', () => {
    const result = extractPrimitiveProps({}, reactNodes());
    expect(result).toEqual({});
  });

  // ── Render-layer XSS mitigation contract (sanitizeComponentProps) ──────

  test('XSS: strips javascript: URL from href before it reaches live React', () => {
    const attrs = { props: { href: 'javascript:alert(1)', title: 'bad' } };
    const result = extractPrimitiveProps(attrs, reactNodes());
    expect(result.href).toBe('#');
    expect(result.title).toBe('bad');
  });

  test('XSS: drops dangerouslySetInnerHTML entirely', () => {
    const attrs = {
      props: {
        dangerouslySetInnerHTML: { __html: '<img src=x onerror=alert(1)>' },
        title: 'safe',
      },
    };
    const result = extractPrimitiveProps(attrs, reactNodes());
    expect(result).not.toHaveProperty('dangerouslySetInnerHTML');
    expect(result.title).toBe('safe');
  });

  test('XSS: drops every on* event-handler prop', () => {
    const attrs = {
      props: { onClick: 'alert(1)', onError: 'alert(2)', title: 'safe' },
    };
    const result = extractPrimitiveProps(attrs, reactNodes());
    expect(result).not.toHaveProperty('onClick');
    expect(result).not.toHaveProperty('onError');
    expect(result.title).toBe('safe');
  });

  test('XSS: sanitizes nested URLs inside array-of-objects (InlineTOC.items shape)', () => {
    const attrs = {
      props: {
        items: [
          { title: 'bad', url: 'javascript:alert(1)' },
          { title: 'good', url: 'https://ok.example.com' },
        ],
      },
    };
    const result = extractPrimitiveProps(attrs, reactNodes());
    const items = result.items as Array<{ title: string; url: string }>;
    expect(items[0].url).toBe('#');
    expect(items[1].url).toBe('https://ok.example.com');
  });

  test('XSS: drops style with url(javascript:…)', () => {
    const attrs = {
      props: { style: 'background: url(javascript:alert(1)); color: red' },
    };
    const result = extractPrimitiveProps(attrs, reactNodes());
    expect(result.style).toBe('');
  });
});

describe('getElementJsxAttrs', () => {
  test('returns attrs for element-kind jsxComponent nodes', () => {
    const attrs = {
      kind: 'element',
      componentName: 'Callout',
      props: { title: 'Heads up' },
    };

    expect(getElementJsxAttrs(attrs)).toBe(attrs);
  });

  test('returns null for expression-kind jsxComponent nodes', () => {
    expect(
      getElementJsxAttrs({
        kind: 'expression',
        sourceRaw: '{/* comment */}',
        props: { title: 'should not be writable' },
      }),
    ).toBeNull();
  });

  test('returns null when kind is absent', () => {
    expect(getElementJsxAttrs({ props: {} })).toBeNull();
  });
});

describe('stableHash', () => {
  // Load-bearing invariant: the ErrorBoundary reset key depends on two props
  // objects with identical (key, value) pairs hashing to the same string,
  // regardless of insertion order. Without this, post-edit re-serialization
  // reorders keys and the boundary remounts mid-typing, stealing focus.
  test('key-order independence — primary load-bearing invariant', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ type: 'warn', title: 'x' })).toBe(stableHash({ title: 'x', type: 'warn' }));
  });

  test('recurses into nested objects — inner key order also normalized', () => {
    expect(stableHash({ x: { b: 1, a: 2 } })).toBe(stableHash({ x: { a: 2, b: 1 } }));
  });

  test('arrays are order-sensitive — [1,2] and [2,1] hash distinctly', () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  test('primitives and null round-trip via JSON.stringify', () => {
    expect(stableHash(null)).toBe('null');
    expect(stableHash(42)).toBe('42');
    expect(stableHash('hello')).toBe('"hello"');
    expect(stableHash(true)).toBe('true');
  });

  test('empty object + empty array + undefined have distinct hashes', () => {
    expect(stableHash({})).toBe('{}');
    expect(stableHash([])).toBe('[]');
    expect(stableHash(undefined)).toBe(JSON.stringify(undefined));
  });
});

const VIEW_FILE = join(dirname(fileURLToPath(import.meta.url)), 'JsxComponentView.tsx');
const SET_NODE_MARKUP_GUARD_WINDOW = 40;

function findSetNodeMarkupSitesWithoutElementAttrsHelper(
  source: string,
): Array<{ line: number; snippet: string }> {
  const lines = source.split('\n');
  const offenders: Array<{ line: number; snippet: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (!line.includes('setNodeMarkup(')) continue;
    const priorWindow = lines.slice(Math.max(0, i - SET_NODE_MARKUP_GUARD_WINDOW), i).join('\n');
    if (!priorWindow.includes('getElementJsxAttrs(')) {
      offenders.push({ line: i + 1, snippet: trimmed.slice(0, 100) });
    }
  }
  return offenders;
}

describe('JsxComponentView setNodeMarkup write-boundary coverage', () => {
  test('finder flags a setNodeMarkup call without nearby getElementJsxAttrs', () => {
    const offenders = findSetNodeMarkupSitesWithoutElementAttrsHelper(`
      function update() {
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...curNode.attrs }));
      }
    `);

    expect(offenders).toEqual([
      {
        line: 3,
        snippet:
          'editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...curNode.attrs }));',
      },
    ]);
  });

  test('finder accepts a setNodeMarkup call guarded by getElementJsxAttrs', () => {
    const offenders = findSetNodeMarkupSitesWithoutElementAttrsHelper(`
      function update() {
        const elementAttrs = getElementJsxAttrs(curNode.attrs);
        if (!elementAttrs) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...elementAttrs }));
      }
    `);

    expect(offenders).toEqual([]);
  });

  test('every setNodeMarkup call site uses getElementJsxAttrs nearby', () => {
    const source = readFileSync(VIEW_FILE, 'utf8');
    const offenders = findSetNodeMarkupSitesWithoutElementAttrsHelper(source);

    expect(
      offenders,
      `setNodeMarkup call site(s) without a nearby getElementJsxAttrs guard: ${JSON.stringify(
        offenders,
      )}`,
    ).toEqual([]);
  });
});
