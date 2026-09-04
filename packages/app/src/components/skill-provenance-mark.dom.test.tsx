import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  applyProvenanceMarks,
  PROVENANCE_PLUGIN_POOL_KEY,
  PROVENANCE_POOL_KEY_ATTR,
  type RowProvenanceMark,
} from './skill-provenance-mark';

function row(path: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-type', 'item');
  el.dataset.itemPath = path;
  const icon = document.createElement('div');
  icon.setAttribute('data-item-section', 'icon');
  const content = document.createElement('div');
  content.setAttribute('data-item-section', 'content');
  el.append(icon, content);
  return el;
}

function host(...paths: string[]): HTMLElement {
  const root = document.createElement('div');
  for (const p of paths) root.appendChild(row(p));
  return root;
}

function pool(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `<span ${PROVENANCE_POOL_KEY_ATTR}="${PROVENANCE_PLUGIN_POOL_KEY}"><svg aria-label="Package icon"><title>Package icon</title></svg></span>`;
  return el;
}

function apply(root: HTMLElement, markFor: (p: string) => RowProvenanceMark, iconPool = pool()) {
  applyProvenanceMarks(root, { markFor, iconPool, version: 'light' });
}

const marks = (root: HTMLElement) => root.querySelectorAll('[data-ok-provenance-mark]');

describe('applyProvenanceMarks', () => {
  test('a publisher mark renders the avatar at the leading edge, after the row icon', () => {
    const root = host('PROJECT/open-knowledge-skills');
    apply(root, () => ({ kind: 'publisher', login: 'inkeep', title: 'Published by inkeep' }));

    const mark = marks(root)[0];
    expect(mark).toBeTruthy();
    expect(mark?.previousElementSibling?.getAttribute('data-item-section')).toBe('icon');
    expect(mark?.querySelector('img')?.getAttribute('src')).toContain('github.com/inkeep.png');
  });

  test('a plugin mark clones the glyph out of the pool', () => {
    const root = host('PROJECT/eng');
    apply(root, () => ({ kind: 'plugin', title: 'Part of the eng plugin' }));
    expect(marks(root)[0]?.querySelector('svg')).toBeTruthy();
  });

  test('rows the resolver declines get no mark', () => {
    const root = host('PROJECT/mine');
    apply(root, () => null);
    expect(marks(root)).toHaveLength(0);
  });

  test('an unchanged row is not rewritten — the loop guard the observer relies on', () => {
    const root = host('PROJECT/eng');
    const mark: RowProvenanceMark = { kind: 'plugin', title: 'Part of the eng plugin' };
    apply(root, () => mark);
    const first = marks(root)[0];
    apply(root, () => mark);
    expect(marks(root)[0]).toBe(first);
  });

  test('a changed publisher rebuilds the mark', () => {
    const root = host('PROJECT/x');
    apply(root, () => ({ kind: 'publisher', login: 'inkeep', title: 'a' }));
    apply(root, () => ({ kind: 'publisher', login: 'anthropics', title: 'b' }));
    expect(marks(root)[0]?.querySelector('img')?.getAttribute('src')).toContain('anthropics.png');
  });

  test('a mark is removed when the row stops qualifying', () => {
    const root = host('PROJECT/x');
    apply(root, () => ({ kind: 'plugin', title: 'p' }));
    expect(marks(root)).toHaveLength(1);
    apply(root, () => null);
    expect(marks(root)).toHaveLength(0);
  });

  test('an avatar that fails to load shows nothing, and is never re-requested', () => {
    const root = host('PROJECT/gone');
    const mark: RowProvenanceMark = { kind: 'publisher', login: 'deleted-org-a', title: 't' };
    apply(root, () => mark);
    const img = marks(root)[0]?.querySelector('img');
    expect(img).toBeTruthy();

    img?.dispatchEvent(new Event('error'));
    expect(marks(root)[0]?.querySelector('img')).toBeNull();
    const after = marks(root)[0];
    expect(after).toBeTruthy();
    apply(root, () => mark);
    expect(marks(root)[0]).toBe(after);
    expect(marks(root)[0]?.querySelector('img')).toBeNull();
  });

  test('a plugin mark is not left as an empty box when the icon pool is absent', () => {
    const root = host('PROJECT/eng');
    const empty = document.createElement('div');
    apply(root, () => ({ kind: 'plugin', title: 'p' }), empty);
    expect(marks(root)).toHaveLength(0);
    apply(root, () => ({ kind: 'plugin', title: 'p' }));
    expect(marks(root)[0]?.querySelector('svg')).toBeTruthy();
  });

  test('a mark WITH a destination is an anchor that opens out and names itself', () => {
    const root = host('GLOBAL/open-knowledge-skills');
    apply(root, () => ({
      kind: 'publisher',
      login: 'inkeep',
      title: 'View inkeep on skills.sh',
      href: 'https://www.skills.sh/inkeep/open-knowledge-skills',
    }));
    const mark = marks(root)[0];
    expect(mark?.tagName).toBe('A');
    expect(mark?.getAttribute('href')).toBe('https://www.skills.sh/inkeep/open-knowledge-skills');
    expect(mark?.getAttribute('rel')).toContain('noreferrer');
    expect(mark?.hasAttribute('aria-hidden')).toBe(false);
    expect(mark?.getAttribute('aria-label')).toBe('View inkeep on skills.sh (opens in a new tab)');
  });

  test('gaining a destination swaps the span for an anchor rather than keeping it', () => {
    const root = host('GLOBAL/x');
    apply(root, () => ({ kind: 'publisher', login: 'inkeep', title: 'Published by inkeep' }));
    expect(marks(root)[0]?.tagName).toBe('SPAN');
    apply(root, () => ({
      kind: 'publisher',
      login: 'inkeep',
      title: 'View inkeep on skills.sh',
      href: 'https://www.skills.sh/inkeep/x',
    }));
    expect(marks(root)).toHaveLength(1);
    expect(marks(root)[0]?.tagName).toBe('A');
  });

  test('the mark is decorative — the row label is the accessible name', () => {
    const root = host('PROJECT/eng');
    apply(root, () => ({ kind: 'plugin', title: 'Part of the eng plugin' }));
    const mark = marks(root)[0];
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.getAttribute('title')).toBe('Part of the eng plugin');
  });
});

test('renders in a real document', () => {
  const { container } = render(<div data-testid="probe" />);
  expect(container.querySelector('[data-testid="probe"]')).toBeTruthy();
});
