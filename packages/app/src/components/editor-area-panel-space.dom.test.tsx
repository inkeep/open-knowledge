import { act, cleanup, render } from '@testing-library/react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  findRailPanelGroup,
  reportUnexpectedPanelGroupFailure,
  resolveRailPanelSpace,
  resolveRailPanelSpacePx,
} from './editor-area-panel-space';

const SEPARATOR_WIDTH_PX = 1;

function railPanels(group: HTMLElement) {
  return [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')];
}

function measurePanelsFromFlexGrow(container: HTMLElement, groupBoxPx: number) {
  const group = findRailPanelGroup(container);
  if (group == null) throw new Error('panel group not found');
  const panels = railPanels(group);
  const separatorCount = group.querySelectorAll(':scope > [data-separator]').length;
  const panelSpacePx = groupBoxPx - separatorCount * SEPARATOR_WIDTH_PX;
  const totalGrow = panels.reduce(
    (total, panel) => total + Number.parseFloat(panel.style.flexGrow || '0'),
    0,
  );
  for (const panel of panels) {
    const grow = Number.parseFloat(panel.style.flexGrow || '0');
    const width = totalGrow === 0 ? 0 : (grow / totalGrow) * panelSpacePx;
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 }),
    });
    Object.defineProperty(panel, 'offsetWidth', {
      configurable: true,
      get: () => Math.round(width),
    });
  }
  return { panelSpacePx, panels };
}

function stubPanelWidths(container: HTMLElement, widths: readonly number[]) {
  const group = findRailPanelGroup(container);
  if (group == null) throw new Error('panel group not found');
  const panels = railPanels(group);
  if (panels.length !== widths.length) {
    throw new Error(`expected ${widths.length} panels, found ${panels.length}`);
  }
  panels.forEach((panel, index) => {
    const width = widths[index] ?? 0;
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 }),
    });
    Object.defineProperty(panel, 'offsetWidth', {
      configurable: true,
      get: () => Math.round(width),
    });
  });
}

function buildRailContainer(panelIds: readonly string[]): HTMLElement {
  const container = document.createElement('div');
  const group = document.createElement('div');
  group.setAttribute('data-group', 'true');
  container.append(group);
  for (const id of panelIds) {
    const panel = document.createElement('div');
    panel.setAttribute('data-panel', 'true');
    panel.id = id;
    group.append(panel);
  }
  document.body.append(container);
  return container;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('a panel library failure is reported only when it is not the library still registering', () => {
  function warningsFor(error: unknown, context?: Record<string, unknown>): unknown[] {
    const warnings: unknown[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(JSON.parse(String(message)));
    });
    reportUnexpectedPanelGroupFailure('panel-resize-failed', error, context);
    warnSpy.mockRestore();
    return warnings;
  }

  test.each([
    'Could not find Group with id ":r1:"',
    'Group :r1: not found',
    'Layout not found for Panel doc-panel',
    'Panel constraints not found for Panel doc-panel',
  ])('%s is expected and stays quiet', (message) => {
    expect(warningsFor(new Error(message))).toEqual([]);
  });

  test.each<[string, unknown, string]>([
    ['an unrelated error', new Error('size out of range'), 'size out of range'],
    ['a message that only mentions not found', new Error('Panel not found'), 'Panel not found'],
    ['a thrown non-Error', 'layout exploded', 'layout exploded'],
  ])('%s is reported with its event and message', (_label, error, message) => {
    expect(warningsFor(error)).toEqual([{ event: 'panel-resize-failed', error: message }]);
  });

  test('context adds fields but never replaces the event or the error', () => {
    expect(
      warningsFor(new Error('size out of range'), {
        event: 'renamed',
        error: 'masked',
        decision: 'sync-doc-presence',
      }),
    ).toEqual([
      { event: 'panel-resize-failed', error: 'size out of range', decision: 'sync-doc-presence' },
    ]);
  });
});

describe('rail panel space is the sum of the panels, not an estimate from one of them', () => {
  test('resolves the exact fractional space a flex container distributes', () => {
    const container = buildRailContainer(['editor-workspace', 'doc-panel']);
    const panelSpacePx = 1609.4;
    const shares = [0.8012, 0.1988];
    stubPanelWidths(
      container,
      shares.map((share) => share * panelSpacePx),
    );

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(panelSpacePx, 6);
    expect(resolveRailPanelSpace(container)).toEqual({
      ok: true,
      panelSpacePx: expect.closeTo(panelSpacePx, 6),
    });
  });

  test('a panel whose offsetWidth rounds away from its rendered width does not move the result', () => {
    const container = buildRailContainer(['editor-workspace', 'doc-panel']);
    const widths = [1000.25, 320.4998];
    stubPanelWidths(container, widths);

    const docPanel = container.querySelector('#doc-panel');
    if (!(docPanel instanceof HTMLElement)) throw new Error('doc panel not found');
    expect(docPanel.offsetWidth).toBe(320);

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(
      widths.reduce((total, width) => total + width, 0),
      6,
    );
  });

  test('a nested group inside a panel does not contribute its panels', () => {
    const container = buildRailContainer(['editor-workspace', 'doc-panel']);
    const editorPanel = container.querySelector('#editor-workspace');
    if (!(editorPanel instanceof HTMLElement)) throw new Error('editor panel not found');
    const nestedGroup = document.createElement('div');
    nestedGroup.setAttribute('data-group', 'true');
    const nestedPanel = document.createElement('div');
    nestedPanel.setAttribute('data-panel', 'true');
    nestedPanel.id = 'editor-split-pane';
    nestedGroup.append(nestedPanel);
    editorPanel.append(nestedGroup);
    stubPanelWidths(container, [1320, 320]);

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(1640, 6);
  });

  test('refuses to answer when the container holds no panel group', () => {
    const container = document.createElement('div');
    document.body.append(container);
    expect(resolveRailPanelSpacePx(container)).toBeNull();
    expect(resolveRailPanelSpacePx(null)).toBeNull();
  });
});

describe('a refusal to resolve the panel space names the structure that was missing', () => {
  test('a container with no panel group refuses on the group, present or absent', () => {
    const container = document.createElement('div');
    document.body.append(container);

    expect(resolveRailPanelSpace(container)).toEqual({
      ok: false,
      refusal: 'group-element-missing',
    });
    expect(resolveRailPanelSpace(null)).toEqual({ ok: false, refusal: 'group-element-missing' });
    expect(resolveRailPanelSpacePx(container)).toBeNull();
  });

  test('a panel group holding no panels refuses on the panels, not the group', () => {
    const container = buildRailContainer([]);
    const group = findRailPanelGroup(container);
    if (group == null) throw new Error('panel group not found');

    expect(railPanels(group)).toEqual([]);
    expect(resolveRailPanelSpace(container)).toEqual({ ok: false, refusal: 'panels-unreadable' });
    expect(resolveRailPanelSpacePx(container)).toBeNull();
  });

  test('panels that rendered with no width of their own refuse on the space, not the markup', () => {
    const container = buildRailContainer(['editor-workspace', 'doc-panel']);
    const group = findRailPanelGroup(container);
    if (group == null) throw new Error('panel group not found');
    stubPanelWidths(container, [0, 0]);

    expect(railPanels(group)).toHaveLength(2);
    expect(resolveRailPanelSpace(container)).toEqual({ ok: false, refusal: 'panel-space-empty' });
    expect(resolveRailPanelSpacePx(container)).toBeNull();
  });
});

describe('the markers the resolver keys on are the ones the panel library guarantees', () => {
  test('a rendered ResizablePanelGroup exposes them, and flex-grow shares drive panel widths', () => {
    const view = render(
      <div data-editor-inner-panels="">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="80%" />
          <ResizableHandle />
          <ResizablePanel id="doc-panel" defaultSize="20%" />
        </ResizablePanelGroup>
      </div>,
    );
    const container = view.container.querySelector('[data-editor-inner-panels]');
    if (!(container instanceof HTMLElement)) throw new Error('inner row not found');

    const group = findRailPanelGroup(container);
    expect(group).toBe(container.firstElementChild);
    if (group == null) throw new Error('panel group not found');
    const panels = railPanels(group);
    expect(panels).toHaveLength(2);
    expect(panels.at(-1)?.id).toBe('doc-panel');

    let measured: ReturnType<typeof measurePanelsFromFlexGrow> | null = null;
    act(() => {
      measured = measurePanelsFromFlexGrow(container, 1612);
    });
    if (measured == null) throw new Error('panels were not measured');
    const { panelSpacePx } = measured;
    expect(panelSpacePx).toBe(1611);

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(panelSpacePx, 6);
  });

  test('a panel rendered straight from the library still counts toward the panel space', () => {
    const view = render(
      <div data-editor-inner-panels="">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="50%" />
          <ResizableHandle />
          <ResizablePrimitive.Panel id="doc-panel" defaultSize="50%" />
        </ResizablePanelGroup>
      </div>,
    );
    const container = view.container.querySelector('[data-editor-inner-panels]');
    if (!(container instanceof HTMLElement)) throw new Error('inner row not found');
    const docPanel = container.querySelector('#doc-panel');
    if (!(docPanel instanceof HTMLElement)) throw new Error('doc panel not found');
    expect(docPanel.getAttribute('data-slot')).toBeNull();

    let measured: ReturnType<typeof measurePanelsFromFlexGrow> | null = null;
    act(() => {
      measured = measurePanelsFromFlexGrow(container, 1201);
    });
    if (measured == null) throw new Error('panels were not measured');
    const { panelSpacePx } = measured;
    expect(panelSpacePx).toBe(1200);

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(panelSpacePx, 6);
  });
});
