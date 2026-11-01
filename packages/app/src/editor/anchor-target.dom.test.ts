import { cleanup, render } from '@testing-library/react';
import { createElement, Fragment } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { anchorFromHash, hashFromMirrorSource } from '@/lib/doc-hash';
import { findAnchorTarget } from './anchor-target';
import { MirrorSource } from './components/MirrorSource';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeAll(() => {
  if (typeof globalThis.CSS?.escape !== 'function') {
    vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) });
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('findAnchorTarget', () => {
  test('finds a heading by its exact id', () => {
    const root = mount('<h2 id="data-model-v2">Data model: v2</h2>');
    expect(findAnchorTarget(root, 'data-model-v2')?.textContent).toBe('Data model: v2');
  });

  test('finds a rendered Mirror Source block by its name', () => {
    const root = mount('');
    render(createElement(MirrorSource, { name: 'block-1' }, 'Mirrored'), { container: root });
    expect(findAnchorTarget(root, 'block-1')?.textContent).toContain('Mirrored');
  });

  test('a Mirror link lands on its source block even where a heading has the same id', () => {
    const root = mount('');
    render(
      createElement(
        Fragment,
        null,
        createElement('h2', { id: 'plans' }, 'Plans'),
        createElement(MirrorSource, { name: 'plans' }, 'First source'),
        createElement(MirrorSource, { name: 'plans-1' }, 'Second source'),
        createElement('h2', { id: 'plans-1' }, 'Plans'),
      ),
      { container: root },
    );
    const mirrorLinkAnchor = (name: string) =>
      anchorFromHash(hashFromMirrorSource('pricing', name)) ?? '';

    expect(findAnchorTarget(root, mirrorLinkAnchor('plans'))?.textContent).toContain(
      'First source',
    );
    expect(findAnchorTarget(root, mirrorLinkAnchor('plans-1'))?.textContent).toContain(
      'Second source',
    );
    expect(findAnchorTarget(root, 'plans')?.tagName).toBe('H2');
    expect(findAnchorTarget(root, 'plans-1')?.tagName).toBe('H2');
  });

  test('a heading anchor that happens to start with `source:` still finds the heading', () => {
    const root = mount('<h2 id="source-notes">Source: notes</h2>');
    expect(findAnchorTarget(root, 'source: notes')?.textContent).toBe('Source: notes');
  });

  test('finds a Korean heading from an anchor written as decomposed jamo', () => {
    const root = mount('<h2 id="한국어">한국어</h2>');
    expect(findAnchorTarget(root, '한국어'.normalize('NFD'))?.textContent).toBe('한국어');
  });

  test('finds a heading from an anchor that spells its text instead of its slug', () => {
    const root = mount('<h2 id="data-model-v2">Data model: v2</h2><h2 id="ガラス">ガラス</h2>');
    expect(findAnchorTarget(root, 'Data model: v2')?.textContent).toBe('Data model: v2');
    expect(findAnchorTarget(root, 'ガラス'.normalize('NFD'))?.textContent).toBe('ガラス');
  });

  test('an exact id wins over a slug match, and a missing anchor finds nothing', () => {
    const root = mount('<h2 id="Notes">Exact</h2><h2 id="notes">Slugged</h2>');
    expect(findAnchorTarget(root, 'Notes')?.textContent).toBe('Exact');
    expect(findAnchorTarget(root, 'missing')).toBeNull();
    expect(findAnchorTarget(root, '!!!')).toBeNull();
  });
});
