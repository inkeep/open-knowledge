import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtInComponents } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { JsxComponentDescriptor } from '../registry/types.ts';
import { attrsWithChangedProp, getElementJsxAttrs, stableHash } from './JsxComponentView.tsx';
import { extractPrimitiveProps } from './jsx-render-contract.ts';

function descriptorWith(
  ...reactNodeNames: string[]
): Pick<JsxComponentDescriptor, 'props' | 'reactNodePropNames'> {
  return { props: [], reactNodePropNames: new Set(reactNodeNames) };
}

describe('extractPrimitiveProps', () => {
  test('passes through declared non-reactnode props', () => {
    const attrs = { props: { type: 'warning', title: 'Heads up' } };
    const result = extractPrimitiveProps(attrs, descriptorWith());
    expect(result).toEqual({ type: 'warning', title: 'Heads up' });
  });

  test('excludes reactnode-typed prop names (content holes are NOT render-time props)', () => {
    const attrs = { props: { title: 'Hi', children: 'shouldnt be here' } };
    const result = extractPrimitiveProps(attrs, descriptorWith('children'));
    expect(result).toEqual({ title: 'Hi' });
    expect(result).not.toHaveProperty('children');
  });

  test('REGRESSION: undeclared attrs pass through (e.g. InlineTOC items, TypeTable type)', () => {
    const attrs = {
      props: {
        items: [
          { title: 'Intro', url: '#intro', depth: 1 },
          { title: 'Usage', url: '#usage', depth: 2 },
        ],
      },
    };
    const result = extractPrimitiveProps(attrs, descriptorWith('children'));

    expect(result).toHaveProperty('items');
    expect(Array.isArray(result.items)).toBe(true);
    expect((result.items as unknown[]).length).toBe(2);
  });

  test('REGRESSION: preserves unknown attrs alongside declared ones (FR-21 merge symmetry)', () => {
    const attrs = {
      props: {
        title: 'Custom Card',
        description: 'With extras',
        color: '#F05032',
        external: true,
      },
    };
    const result = extractPrimitiveProps(attrs, descriptorWith());
    expect(result).toEqual({
      title: 'Custom Card',
      description: 'With extras',
      color: '#F05032',
      external: true,
    });
  });

  test('handles empty props', () => {
    const result = extractPrimitiveProps({ props: {} }, descriptorWith());
    expect(result).toEqual({});
  });

  test('handles missing props attr', () => {
    const result = extractPrimitiveProps({}, descriptorWith());
    expect(result).toEqual({});
  });

  test('XSS: strips javascript: URL from href before it reaches live React', () => {
    const attrs = { props: { href: 'javascript:alert(1)', title: 'bad' } };
    const result = extractPrimitiveProps(attrs, descriptorWith());
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
    const result = extractPrimitiveProps(attrs, descriptorWith());
    expect(result).not.toHaveProperty('dangerouslySetInnerHTML');
    expect(result.title).toBe('safe');
  });

  test('XSS: drops every on* event-handler prop', () => {
    const attrs = {
      props: { onClick: 'alert(1)', onError: 'alert(2)', title: 'safe' },
    };
    const result = extractPrimitiveProps(attrs, descriptorWith());
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
    const result = extractPrimitiveProps(attrs, descriptorWith());
    const items = result.items as Array<{ title: string; url: string }>;
    expect(items[0].url).toBe('#');
    expect(items[1].url).toBe('https://ok.example.com');
  });

  test('reads a prop written under its older spelling as the current name', () => {
    const mirror = builtInComponents.find((component) => component.name === 'Mirror');
    if (!mirror) throw new Error('no Mirror descriptor');
    const result = extractPrimitiveProps(
      { props: { src: 'pricing', anchor: 'plans' } },
      { props: mirror.props, reactNodePropNames: new Set() },
    );
    expect(result).toEqual({ src: 'pricing', name: 'plans' });
  });

  test('XSS: sanitizes a URL prop written under an older spelling', () => {
    const result = extractPrimitiveProps(
      { props: { destination: 'javascript:alert(1)' } },
      {
        props: [{ name: 'href', type: 'string', required: false, legacyNames: ['destination'] }],
        reactNodePropNames: new Set(),
      },
    );
    expect(result).toEqual({ href: '#' });
  });

  test('XSS: drops style with url(javascript:…)', () => {
    const attrs = {
      props: { style: 'background: url(javascript:alert(1)); color: red' },
    };
    const result = extractPrimitiveProps(attrs, descriptorWith());
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

function componentMeta(componentName: string) {
  const meta = builtInComponents.find((component) => component.name === componentName);
  if (!meta) throw new Error(`no built-in component named ${componentName}`);
  return meta;
}

function authoredElement(componentName: string, authored: Record<string, string>) {
  const attrs = getElementJsxAttrs({
    kind: 'element',
    componentName,
    attributes: Object.entries(authored).map(([name, value]) => ({
      type: 'mdxJsxAttribute',
      name,
      value,
    })),
    props: { ...authored },
    sourceRaw: '',
    sourceDirty: false,
  });
  if (!attrs) throw new Error('expected element attrs');
  return attrs;
}

function serializedAttributes(componentName: string, attrs: Record<string, unknown>) {
  const out = componentMeta(componentName).serialize(
    { attrs } as never,
    {
      all: () => [],
    } as never,
  ) as unknown as { attributes: Array<{ name: string; value: unknown }> };
  return out.attributes.map((attribute) => [attribute.name, attribute.value]);
}

describe('attrsWithChangedProp', () => {
  test('editing the name of a Mirror written with `anchor` writes `name` and drops `anchor`', () => {
    const next = attrsWithChangedProp(
      authoredElement('Mirror', { src: 'pricing', anchor: 'plans' }),
      componentMeta('Mirror'),
      'name',
      'faq',
    );
    expect(next.sourceDirty).toBe(true);
    expect(serializedAttributes('Mirror', next)).toEqual([
      ['src', 'pricing'],
      ['name', 'faq'],
    ]);
  });

  test('editing the name of a MirrorSource written with `id` writes `name` and drops `id`', () => {
    const next = attrsWithChangedProp(
      authoredElement('MirrorSource', { id: 'plans' }),
      componentMeta('MirrorSource'),
      'name',
      'plans',
    );
    expect(serializedAttributes('MirrorSource', next)).toEqual([['name', 'plans']]);
  });

  test('editing another prop keeps an older spelling as authored', () => {
    const next = attrsWithChangedProp(
      authoredElement('Mirror', { src: 'pricing', anchor: 'plans' }),
      componentMeta('Mirror'),
      'src',
      'billing',
    );
    expect(serializedAttributes('Mirror', next)).toEqual([
      ['src', 'billing'],
      ['anchor', 'plans'],
    ]);
  });

  test('clearing a prop removes its attribute', () => {
    const next = attrsWithChangedProp(
      authoredElement('Callout', { type: 'note', title: 'Heads up' }),
      componentMeta('Callout'),
      'title',
      undefined,
    );
    expect(serializedAttributes('Callout', next)).toEqual([['type', 'note']]);
  });

  test('changing an image src forgets the URL the image was authored with', () => {
    const authored = authoredElement('CommonMarkImage', { src: 'chart.png', alt: 'Chart' });
    const next = attrsWithChangedProp(
      { ...authored, props: { ...authored.props, sourceUrl: 'chart.png' } },
      componentMeta('CommonMarkImage'),
      'src',
      'other.png',
    );
    expect(next.props).toEqual({ src: 'other.png', alt: 'Chart' });
  });
});

describe('stableHash', () => {
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
