/**
 * Tabs — DOM-walk contracts.
 *
 * Two helpers live in `Tabs.tsx`, both keyed off the same SLOT_SELECTOR walk:
 *
 *  1. `readTabSlots` — counts the Tabs's OWN direct Tab renderers, the same
 *     set the CSS active-panel reveal counts. Pinned against the regression
 *     where a recursive walk would sweep in every nested nodeview's
 *     `.react-renderer` and emit phantom strip pills (the user-visible
 *     "6 pills instead of 2" on the quickstart, whose Tab 1 nests a Callout
 *     and a multi-Step Steps).
 *  2. `findNthTabGearButton` — resolves the chrome-bar gear button at slot N
 *     so the Notion-style rename gesture (active-pill click → open Tab
 *     PropPanel) can dispatch `.click()` on it. Pins three contracts the
 *     editor relies on: `[data-jsx-gear]` is the canonical selector; slot
 *     index alignment matches `readTabSlots`'s index space (the SAME index
 *     space the strip's pills are rendered with); nested-Tabs scoping
 *     prevents inner Tabs's gears from bleeding into the outer slot set.
 *
 * jsdom substrate per precedent #43 (`bun run test:dom`). Tests build DOM
 * directly via `document.body.innerHTML` rather than rendering through RTL
 * because the helpers are pure DOM-in/values-out — no React state, no PM.
 * `cleanup` from RTL satisfies the *.dom.test.tsx → @testing-library/react
 * value-import contract (precedent #43); it is a no-op against this
 * fixture style.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup } from '@testing-library/react';
import { findNthTabGearButton, readTabSlots } from './Tabs.tsx';

// `cleanup` satisfies the *.dom.test.tsx -> @testing-library/react value-import
// contract (precedent #43); it is a no-op here because these tests build DOM
// directly via `document.body.innerHTML` rather than rendering through RTL.
afterEach(cleanup);
afterEach(() => {
  document.body.innerHTML = '';
});

// React's <NodeViewContent> → PM's contentDOMElement → per-child ReactRenderer.
// Every PM container renders its children through exactly this chain; the CSS
// reveal rules and readTabSlots both key off the `.react-renderer` row at its
// leaf. `childRenderers` is the concatenated `.react-renderer` HTML of the
// container's direct PM children.
function contentDom(childRenderers: string): string {
  // The real Tiptap <NodeViewContent> carries both `.component-children` and
  // `data-node-view-content`; PM's contentDOMElement inside it carries
  // `data-node-view-content-react`. Mirror both so the fixture stays faithful
  // to the stack the CSS comment in globals.css documents.
  return `<div class="component-children" data-node-view-content><div data-node-view-content-react>${childRenderers}</div></div>`;
}

// A single <Tab> nodeview as it appears under a Tabs's contentDOM:
// `.react-renderer > .jsx-component-wrapper[tab] > section.tab-panel[data-tab-*]`.
// `nestedContentDom` is an optional pre-built contentDom(...) block holding the
// Tab's own nested nodeviews (what makes a Tab a container, and what the bug
// over-counts).
function tabRenderer(label: string, id: string, nestedContentDom = ''): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="tab"><section class="tab-panel" data-tab-label="${label}" data-tab-id="${id}">${nestedContentDom}</section></div></div>`;
}

// Variant carrying the chrome-bar gear button — the `[data-jsx-gear]` element
// JsxComponentView renders for any descriptor with editable props. `gearOwner`
// is a per-test marker (e.g. `outer-0`) used by the gear-resolution suite to
// confirm `findNthTabGearButton` returns the gear at the right slot.
function tabRendererWithGear(
  label: string,
  id: string,
  gearOwner: string,
  nestedContentDom = '',
): string {
  // The gear is the first child of the renderer (mirrors `JsxComponentView`'s
  // chrome stamp, where the chrome bar precedes the wrapper). The
  // `data-gear-owner` data-attr is test-only; production gear buttons don't
  // carry it, but the helper only queries `[data-jsx-gear]` so the extra
  // marker is invisible to it.
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-chrome"><button type="button" data-jsx-gear="" data-gear-owner="${gearOwner}"></button></div><div class="jsx-component-wrapper" data-component-type="tab"><section class="tab-panel" data-tab-label="${label}" data-tab-id="${id}">${nestedContentDom}</section></div></div>`;
}

// A generic non-Tab container nodeview (Callout, Steps, Step, ...). `type` is
// its lowercased descriptor name; `childRenderers` are its own direct PM
// children. These are exactly the nodeviews the recursive walk wrongly swept
// into the tab strip.
function containerRenderer(type: string, childRenderers = ''): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="${type}">${contentDom(childRenderers)}</div></div>`;
}

// A full nested <Tabs> nodeview (its own .tabs > .tabs-content scope), as it
// appears under a parent Tab's contentDOM.
function nestedTabsRenderer(innerTabRenderers: string): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="tabs"><div class="tabs"><div class="tabs-content" data-active-index="0">${contentDom(innerTabRenderers)}</div></div></div></div>`;
}

// Mount an outer <Tabs> and return its `.tabs-content` element — the contentRef
// node readTabSlots receives at runtime. The first `.tabs-content` in document
// order is always the outer one (it encloses any nested Tabs).
function mountOuterTabs(tabRenderers: string): HTMLElement {
  document.body.innerHTML = `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="tabs"><div class="tabs"><div class="tabs-content" data-active-index="0">${contentDom(tabRenderers)}</div></div></div></div>`;
  const el = document.body.querySelector<HTMLElement>('.tabs-content');
  if (!el) throw new Error('test DOM build failed: no .tabs-content');
  return el;
}

describe('readTabSlots — counts only the Tabs own direct Tab children', () => {
  test('two plain Tabs yield exactly two slots with verbatim labels and ids', () => {
    const root = mountOuterTabs(tabRenderer('Alpha', 'alpha') + tabRenderer('Bravo', 'bravo'));

    const slots = readTabSlots(root);

    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.label)).toEqual(['Alpha', 'Bravo']);
    expect(slots.map((s) => s.panelId)).toEqual(['alpha', 'bravo']);
  });

  test('a single nested container inside a Tab does not add a phantom slot', () => {
    // Tab 1 wraps one Callout. The Callout is its own
    // `[data-node-view-content-react] > .react-renderer` — the minimal shape
    // that a recursive slot walk miscounts as a third tab.
    const tab1 = tabRenderer(
      'Alpha',
      'alpha',
      contentDom(containerRenderer('callout', '<p>prereq</p>')),
    );
    const root = mountOuterTabs(tab1 + tabRenderer('Bravo', 'bravo'));

    const slots = readTabSlots(root);

    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.label)).toEqual(['Alpha', 'Bravo']);
    expect(slots.map((s) => s.panelId)).toEqual(['alpha', 'bravo']);
  });

  test('the quickstart shape (Tab 1 = Callout + Steps with multiple Steps) yields two slots', () => {
    // Mirrors docs/content/get-started/quickstart.mdx Tab 1: a Callout sibling
    // to a Steps whose contentDOM holds four Step nodeviews. The recursive walk
    // counted Tab1 + Tab2 + Callout + Steps + every Step — the reported phantom
    // pills. Scoped to direct children it is exactly the two real Tabs.
    const steps = containerRenderer(
      'steps',
      containerRenderer('step', '<h3>Install</h3>') +
        containerRenderer('step', '<h3>Create</h3>') +
        containerRenderer('step', '<h3>Initialize</h3>') +
        containerRenderer('step', '<h3>Open</h3>'),
    );
    const tab1 = tabRenderer(
      'macOS app',
      'macos',
      contentDom(containerRenderer('callout', '<ul><li>prereq</li></ul>') + steps),
    );
    const root = mountOuterTabs(tab1 + tabRenderer('Web app', 'web'));

    const slots = readTabSlots(root);

    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.label)).toEqual(['macOS app', 'Web app']);
  });

  test('a nested Tabs inside a Tab contributes no slots to the outer strip', () => {
    // The inner Tabs and its inner Tabs both live under Tab 1s contentDOM. The
    // outer strip must show only the outer two Tabs. (The prior special-case
    // filter excluded the inner Tabs but still counted the inner Tabs container
    // itself; the scoped walk excludes the whole nested subtree.)
    const innerTabs = nestedTabsRenderer(
      tabRenderer('Inner one', 'inner-1') + tabRenderer('Inner two', 'inner-2'),
    );
    const tab1 = tabRenderer('Outer one', 'outer-1', contentDom(innerTabs));
    const root = mountOuterTabs(tab1 + tabRenderer('Outer two', 'outer-2'));

    const slots = readTabSlots(root);

    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.label)).toEqual(['Outer one', 'Outer two']);
    expect(slots.map((s) => s.panelId)).toEqual(['outer-1', 'outer-2']);
  });

  test('a non-Tab block at the top level falls back to a numbered label with null id', () => {
    // A non-Tab block is legal under the `block*` content expression. It still
    // occupies a slot, with a numbered fallback label and no ARIA pairing, so
    // the strip index space stays aligned with the CSS reveal (the load-bearing
    // behavior the header comment documents).
    const root = mountOuterTabs(
      tabRenderer('Real', 'real') + containerRenderer('callout', '<p>note</p>'),
    );

    const slots = readTabSlots(root);

    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ label: 'Real', panelId: 'real' });
    expect(slots[1]).toMatchObject({ label: 'Tab 2', panelId: null });
  });

  test('an empty Tabs yields zero slots', () => {
    // The :scope > chain must not throw or over-match on a bare contentDOM with
    // no renderers (e.g. immediately after mount, before Tiptap fills it).
    expect(readTabSlots(mountOuterTabs(''))).toHaveLength(0);
  });
});

describe('findNthTabGearButton — Notion-style rename gear lookup', () => {
  test('returns the gear button of the Nth Tab in the strip', () => {
    const root = mountOuterTabs(
      tabRendererWithGear('Alpha', 'alpha', 'gear-0') +
        tabRendererWithGear('Bravo', 'bravo', 'gear-1') +
        tabRendererWithGear('Charlie', 'charlie', 'gear-2'),
    );
    expect(findNthTabGearButton(root, 0)?.dataset.gearOwner).toBe('gear-0');
    expect(findNthTabGearButton(root, 1)?.dataset.gearOwner).toBe('gear-1');
    expect(findNthTabGearButton(root, 2)?.dataset.gearOwner).toBe('gear-2');
  });

  test('returns null when the index is out of range', () => {
    const root = mountOuterTabs(
      tabRendererWithGear('Alpha', 'alpha', 'gear-0') +
        tabRendererWithGear('Bravo', 'bravo', 'gear-1'),
    );
    expect(findNthTabGearButton(root, 2)).toBeNull();
    expect(findNthTabGearButton(root, 99)).toBeNull();
  });

  test('returns null when the Tab at the slot has no gear (placeholder mode)', () => {
    // Some descriptors render no PropPanel; JsxComponentView's gear is gated
    // on `hasEditableProps`. The active-pill-click handler must tolerate
    // that — `null` propagates through the `?.click()` chain at the call
    // site as a no-op.
    const root = mountOuterTabs(
      tabRendererWithGear('Alpha', 'alpha', 'gear-0') + tabRenderer('Bravo', 'bravo'),
    );
    expect(findNthTabGearButton(root, 0)).not.toBeNull();
    expect(findNthTabGearButton(root, 1)).toBeNull();
  });

  test('the returned button is the one .click() opens — round-trip the dispatch', () => {
    // The active-pill onClick handler relies on `.click()` actually firing on
    // the resolved node. Round-trip it via a click listener so a regression
    // (helper returns a non-button, or a parent of the gear) fails loud
    // rather than silently doing nothing.
    const root = mountOuterTabs(
      tabRendererWithGear('Alpha', 'alpha', 'gear-0') +
        tabRendererWithGear('Bravo', 'bravo', 'gear-1'),
    );
    const gear = findNthTabGearButton(root, 1);
    expect(gear).not.toBeNull();
    let fired = 0;
    gear?.addEventListener('click', () => {
      fired++;
    });
    gear?.click();
    expect(fired).toBe(1);
  });

  test('nested Tabs: inner pills do NOT count toward the outer Tabs slot set', () => {
    // The inner Tabs's gears live under Tab 1's contentDOM. The outer helper,
    // called on the outer Tabs's `.tabs-content`, must resolve only to the
    // outer slots — index 1 must hit the outer's second tab, not bleed into
    // the inner's slot space. SLOT_SELECTOR's `:scope >` chain enforces this
    // structurally (only the OUTER `.tabs-content`'s direct .component-children
    // matches), but the test pins the behavior at the helper level.
    const innerTabs = nestedTabsRenderer(
      tabRendererWithGear('Inner one', 'inner-1', 'inner-gear-0') +
        tabRendererWithGear('Inner two', 'inner-2', 'inner-gear-1'),
    );
    const tab1 = tabRendererWithGear('Outer one', 'outer-1', 'outer-gear-0', contentDom(innerTabs));
    const root = mountOuterTabs(tab1 + tabRendererWithGear('Outer two', 'outer-2', 'outer-gear-1'));

    expect(findNthTabGearButton(root, 0)?.dataset.gearOwner).toBe('outer-gear-0');
    expect(findNthTabGearButton(root, 1)?.dataset.gearOwner).toBe('outer-gear-1');
    expect(findNthTabGearButton(root, 2)).toBeNull();

    // Mirror: from the inner Tabs's contentRef, the helper sees only the
    // inner's two slots. Confirms scoping isn't anchored to the outermost
    // Tabs in the document.
    const innerContent = document.querySelectorAll<HTMLElement>('.tabs-content')[1];
    if (!innerContent) throw new Error('expected an inner .tabs-content');
    expect(findNthTabGearButton(innerContent, 0)?.dataset.gearOwner).toBe('inner-gear-0');
    expect(findNthTabGearButton(innerContent, 1)?.dataset.gearOwner).toBe('inner-gear-1');
  });
});
