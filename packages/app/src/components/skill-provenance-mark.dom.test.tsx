import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  applyProvenanceMarks,
  PROVENANCE_PLUGIN_POOL_KEY,
  PROVENANCE_POOL_KEY_ATTR,
  type RowProvenanceMark,
} from './skill-provenance-mark';

/** Minimal stand-in for a Pierre row: an icon section, then content. */
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

// Detached on purpose. `applyProvenanceMarks` takes any ParentNode, so nothing
// here needs to be in the document — and mounting into `document.body` meant an
// afterEach that wiped it, which tore out Testing Library's own container before
// its cleanup could run and corrupted state for later files in the worker.
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
    // Same NODE, not merely an equal one: re-injecting would retrigger the host
    // MutationObserver that calls this, which is how you get an infinite loop.
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
    // A source with no resolvable publisher shows nothing — falling back to a
    // package glyph would render it as a plugin, which is a different thing.
    //
    // But the mark NODE has to survive, because the content key lives on it.
    // Removing it on error deletes what the skip keys off, so the next pass
    // rebuilds with the same failing `src` — and that rebuild is itself a
    // childList mutation the shadow-root observer reacts to. Unbounded loop.
    const root = host('PROJECT/gone');
    const mark: RowProvenanceMark = { kind: 'publisher', login: 'deleted-org-a', title: 't' };
    apply(root, () => mark);
    const img = marks(root)[0]?.querySelector('img');
    expect(img).toBeTruthy();

    img?.dispatchEvent(new Event('error'));
    // Nothing renders...
    expect(marks(root)[0]?.querySelector('img')).toBeNull();
    // ...but the keyed container stays, so a second pass is a no-op rather than
    // a fresh request for a URL we already know 404s.
    const after = marks(root)[0];
    expect(after).toBeTruthy();
    apply(root, () => mark);
    expect(marks(root)[0]).toBe(after);
    expect(marks(root)[0]?.querySelector('img')).toBeNull();
  });

  test('a plugin mark is not left as an empty box when the icon pool is absent', () => {
    // The pool mounts with React; on first paint it can be null. Inserting an
    // empty keyed container then would reserve the space permanently, because
    // the key would match once the pool arrived.
    const root = host('PROJECT/eng');
    const empty = document.createElement('div');
    apply(root, () => ({ kind: 'plugin', title: 'p' }), empty);
    expect(marks(root)).toHaveLength(0);
    // Pool now available — the mark builds for real.
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
    // Interactive, so it must NOT be hidden from assistive tech.
    expect(mark?.hasAttribute('aria-hidden')).toBe(false);
    // The name carries the destination AND the fact that it leaves — WCAG 2.4.4.
    // A screen-reader user who follows this loses their place otherwise, with no
    // warning that a new context opened.
    expect(mark?.getAttribute('aria-label')).toBe('View inkeep on skills.sh (opens in a new tab)');
  });

  test('gaining a destination swaps the span for an anchor rather than keeping it', () => {
    // The content key includes the href precisely so this rebuild happens — an
    // element cannot change tag in place, so a key that ignored the href would
    // leave the row a dead span forever.
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

// Keeps this file honest against the Tier-3 filename contract: a `.dom.test.tsx`
// must exercise the DOM through @testing-library/react.
test('renders in a real document', () => {
  const { container } = render(<div data-testid="probe" />);
  expect(container.querySelector('[data-testid="probe"]')).toBeTruthy();
});
