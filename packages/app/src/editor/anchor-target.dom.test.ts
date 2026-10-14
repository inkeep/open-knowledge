import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { findAnchorTarget } from './anchor-target';

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
  document.body.replaceChildren();
});

describe('findAnchorTarget', () => {
  test('finds a heading by its exact id', () => {
    const root = mount('<h2 id="data-model-v2">Data model: v2</h2>');
    expect(findAnchorTarget(root, 'data-model-v2')?.textContent).toBe('Data model: v2');
  });

  test('finds a mirror source by its source id', () => {
    const root = mount('<div data-mirror-source-id="block-1">Mirrored</div>');
    expect(findAnchorTarget(root, 'block-1')?.textContent).toBe('Mirrored');
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
