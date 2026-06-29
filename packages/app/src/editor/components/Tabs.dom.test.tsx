
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup } from '@testing-library/react';
import { findNthTabGearButton, readTabSlots } from './Tabs.tsx';

afterEach(cleanup);
afterEach(() => {
  document.body.innerHTML = '';
});

function contentDom(childRenderers: string): string {
  return `<div class="component-children" data-node-view-content><div data-node-view-content-react>${childRenderers}</div></div>`;
}

function tabRenderer(label: string, id: string, nestedContentDom = ''): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="tab"><section class="tab-panel" data-tab-label="${label}" data-tab-id="${id}">${nestedContentDom}</section></div></div>`;
}

function tabRendererWithGear(
  label: string,
  id: string,
  gearOwner: string,
  nestedContentDom = '',
): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-chrome"><button type="button" data-jsx-gear="" data-gear-owner="${gearOwner}"></button></div><div class="jsx-component-wrapper" data-component-type="tab"><section class="tab-panel" data-tab-label="${label}" data-tab-id="${id}">${nestedContentDom}</section></div></div>`;
}

function containerRenderer(type: string, childRenderers = ''): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="${type}">${contentDom(childRenderers)}</div></div>`;
}

function nestedTabsRenderer(innerTabRenderers: string): string {
  return `<div class="react-renderer node-jsxComponent"><div class="jsx-component-wrapper" data-component-type="tabs"><div class="tabs"><div class="tabs-content" data-active-index="0">${contentDom(innerTabRenderers)}</div></div></div></div>`;
}

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
    const root = mountOuterTabs(
      tabRenderer('Real', 'real') + containerRenderer('callout', '<p>note</p>'),
    );

    const slots = readTabSlots(root);

    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ label: 'Real', panelId: 'real' });
    expect(slots[1]).toMatchObject({ label: 'Tab 2', panelId: null });
  });

  test('an empty Tabs yields zero slots', () => {
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
    const root = mountOuterTabs(
      tabRendererWithGear('Alpha', 'alpha', 'gear-0') + tabRenderer('Bravo', 'bravo'),
    );
    expect(findNthTabGearButton(root, 0)).not.toBeNull();
    expect(findNthTabGearButton(root, 1)).toBeNull();
  });

  test('the returned button is the one .click() opens — round-trip the dispatch', () => {
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
    const innerTabs = nestedTabsRenderer(
      tabRendererWithGear('Inner one', 'inner-1', 'inner-gear-0') +
        tabRendererWithGear('Inner two', 'inner-2', 'inner-gear-1'),
    );
    const tab1 = tabRendererWithGear('Outer one', 'outer-1', 'outer-gear-0', contentDom(innerTabs));
    const root = mountOuterTabs(tab1 + tabRendererWithGear('Outer two', 'outer-2', 'outer-gear-1'));

    expect(findNthTabGearButton(root, 0)?.dataset.gearOwner).toBe('outer-gear-0');
    expect(findNthTabGearButton(root, 1)?.dataset.gearOwner).toBe('outer-gear-1');
    expect(findNthTabGearButton(root, 2)).toBeNull();

    const innerContent = document.querySelectorAll<HTMLElement>('.tabs-content')[1];
    if (!innerContent) throw new Error('expected an inner .tabs-content');
    expect(findNthTabGearButton(innerContent, 0)?.dataset.gearOwner).toBe('inner-gear-0');
    expect(findNthTabGearButton(innerContent, 1)?.dataset.gearOwner).toBe('inner-gear-1');
  });
});
