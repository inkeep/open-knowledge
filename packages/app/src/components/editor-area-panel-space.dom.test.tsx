import { act, cleanup, fireEvent, render } from '@testing-library/react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  describeRailFloorShortfall,
  describeRailWidthShortfall,
  findRailPanelGroup,
  resolveRailPanelSpace,
  resolveRailPanelSpacePx,
} from './editor-area-panel-space';
import { RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX } from './right-rail-admission';

const PREFERRED_TERMINAL_WIDTH_PX = 740;
const SPEC_TERMINAL_WIDTH_FLOOR_PX = 739;
const DOC_PANEL_FLOOR_PX = 300;
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

describe('rail panel space is the sum of the panels, not an estimate from one of them', () => {
  test('resolves the exact fractional space a flex container distributes', () => {
    const container = buildRailContainer([
      'editor-main',
      'doc-panel',
      'terminal-column',
      'agents-column',
    ]);
    const panelSpacePx = 1609.4;
    const shares = [0.29, 0.1988, 0.4598, 0.0514];
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
    const container = buildRailContainer(['editor-main', 'doc-panel', 'terminal-column']);
    const widths = [1000.25, 320.4998, PREFERRED_TERMINAL_WIDTH_PX];
    stubPanelWidths(container, widths);

    const docPanel = container.querySelector('#doc-panel');
    if (!(docPanel instanceof HTMLElement)) throw new Error('doc panel not found');
    expect(docPanel.offsetWidth).toBe(320);

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(
      widths.reduce((total, width) => total + width, 0),
      6,
    );
  });

  test('a terminal pin taken against the resolved space renders above the spec floor', () => {
    const container = buildRailContainer([
      'editor-main',
      'doc-panel',
      'terminal-column',
      'agents-column',
    ]);
    const panelSpacePx = 1609.4;
    stubPanelWidths(container, [469.4, 320, PREFERRED_TERMINAL_WIDTH_PX, 80]);

    const resolvedSpacePx = resolveRailPanelSpacePx(container);
    if (resolvedSpacePx == null) throw new Error('panel space did not resolve');
    const renderedWidthPx =
      ((PREFERRED_TERMINAL_WIDTH_PX / resolvedSpacePx) * 100 * panelSpacePx) / 100;

    expect(renderedWidthPx).toBeCloseTo(PREFERRED_TERMINAL_WIDTH_PX, 6);
    expect(renderedWidthPx).toBeGreaterThan(SPEC_TERMINAL_WIDTH_FLOOR_PX);
  });

  test('a nested group inside a panel does not contribute its panels', () => {
    const container = buildRailContainer(['editor-main', 'terminal-column']);
    const editorPanel = container.querySelector('#editor-main');
    if (!(editorPanel instanceof HTMLElement)) throw new Error('editor panel not found');
    const nestedGroup = document.createElement('div');
    nestedGroup.setAttribute('data-group', 'true');
    const nestedPanel = document.createElement('div');
    nestedPanel.setAttribute('data-panel', 'true');
    nestedPanel.id = 'bottom-dock';
    nestedGroup.append(nestedPanel);
    editorPanel.append(nestedGroup);
    stubPanelWidths(container, [900, PREFERRED_TERMINAL_WIDTH_PX]);

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
    const container = buildRailContainer(['editor-main', 'terminal-column']);
    const group = findRailPanelGroup(container);
    if (group == null) throw new Error('panel group not found');
    stubPanelWidths(container, [0, 0]);

    expect(railPanels(group)).toHaveLength(2);
    expect(resolveRailPanelSpace(container)).toEqual({ ok: false, refusal: 'panel-space-empty' });
    expect(resolveRailPanelSpacePx(container)).toBeNull();
  });
});

describe('a pin that did not land is reported with the width it actually got', () => {
  test('names every pinned column whose width missed its target by more than a pixel', () => {
    const shortfall = describeRailWidthShortfall(
      { 'terminal-column': PREFERRED_TERMINAL_WIDTH_PX, 'agents-column': 400 },
      new Map([
        ['terminal-column', 738.62],
        ['agents-column', 400.38],
      ]),
    );

    expect(Object.keys(shortfall)).toEqual(['terminal-column']);
    expect(shortfall['terminal-column']?.targetPx).toBe(PREFERRED_TERMINAL_WIDTH_PX);
    expect(shortfall['terminal-column']?.renderedPx).toBeCloseTo(738.62, 6);
  });

  test('reports nothing when every pinned column landed', () => {
    expect(
      describeRailWidthShortfall(
        { 'terminal-column': PREFERRED_TERMINAL_WIDTH_PX },
        new Map([
          ['editor-main', 870],
          ['terminal-column', PREFERRED_TERMINAL_WIDTH_PX],
        ]),
      ),
    ).toEqual({});
  });

  test('a pinned column with no width of its own is not reported the way a landed pin is', () => {
    expect(
      describeRailWidthShortfall(
        { 'terminal-column': PREFERRED_TERMINAL_WIDTH_PX },
        new Map([['doc-panel', 320]]),
      ),
    ).toEqual({ 'terminal-column': { targetPx: PREFERRED_TERMINAL_WIDTH_PX, renderedPx: null } });
  });
});

describe('a floor that could not be honoured names only the columns rendered under it', () => {
  test('a column wider than its floor is left out while a column under its floor is named', () => {
    const shortfall = describeRailFloorShortfall(
      {
        'terminal-column': RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
        'doc-panel': DOC_PANEL_FLOOR_PX,
      },
      new Map([
        ['terminal-column', PREFERRED_TERMINAL_WIDTH_PX],
        ['doc-panel', 40],
      ]),
    );

    expect(Object.keys(shortfall)).toEqual(['doc-panel']);
    expect(shortfall['doc-panel']).toEqual({ targetPx: DOC_PANEL_FLOOR_PX, renderedPx: 40 });
  });

  test('a hidden column still holding width is named even though it is over its pin', () => {
    const shortfall = describeRailFloorShortfall(
      {
        'agents-column': 0,
        'terminal-column': RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
      },
      new Map([
        ['agents-column', 400],
        ['terminal-column', PREFERRED_TERMINAL_WIDTH_PX],
      ]),
    );

    expect(Object.keys(shortfall)).toEqual(['agents-column']);
    expect(shortfall['agents-column']).toEqual({ targetPx: 0, renderedPx: 400 });
  });

  test('reports nothing when every column sits within a pixel of the floor it needs', () => {
    expect(
      describeRailFloorShortfall(
        {
          'terminal-column': RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
          'doc-panel': DOC_PANEL_FLOOR_PX,
        },
        new Map([
          ['terminal-column', RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - 0.5],
          ['doc-panel', DOC_PANEL_FLOOR_PX],
        ]),
      ),
    ).toEqual({});
  });
});

describe('the markers the resolver keys on are the ones the panel library guarantees', () => {
  test('a rendered ResizablePanelGroup exposes them, and flex-grow shares drive panel widths', () => {
    const view = render(
      <div data-editor-area-panels="">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="editor-main" defaultSize="29%" />
          <ResizableHandle />
          <ResizablePanel id="terminal-column" defaultSize="46%" />
          <ResizableHandle />
          <ResizablePanel id="agents-column" defaultSize="25%" />
        </ResizablePanelGroup>
      </div>,
    );
    const container = view.container.querySelector('[data-editor-area-panels]');
    if (!(container instanceof HTMLElement)) throw new Error('rail container not found');

    const group = findRailPanelGroup(container);
    expect(group).toBe(container.firstElementChild);
    if (group == null) throw new Error('panel group not found');
    expect(railPanels(group).map((panel) => panel.id)).toEqual([
      'editor-main',
      'terminal-column',
      'agents-column',
    ]);

    let measured: ReturnType<typeof measurePanelsFromFlexGrow> | null = null;
    act(() => {
      measured = measurePanelsFromFlexGrow(container, 1612);
    });
    if (measured == null) throw new Error('panels were not measured');
    const { panelSpacePx } = measured;
    expect(panelSpacePx).toBe(1610);

    expect(resolveRailPanelSpacePx(container)).toBeCloseTo(panelSpacePx, 6);
  });

  test('the agents-only separator reports and keyboard-resizes the Agents pane', () => {
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function () {
        if (this.id === 'editor-main') return 700;
        if (this.id === 'agents-column') return 300;
        return 0;
      });
    const offsetLeft = vi
      .spyOn(HTMLElement.prototype, 'offsetLeft', 'get')
      .mockImplementation(function () {
        if (this.id === 'terminal-column') return 700;
        if (this.id === 'agents-column') return 701;
        if (this.hasAttribute('data-separator')) {
          const separators = [...(this.parentElement?.querySelectorAll('[data-separator]') ?? [])];
          return separators.indexOf(this) === 0 ? 699 : 700;
        }
        return 0;
      });
    try {
      const view = render(
        <ResizablePanelGroup
          id="agents-only-aria-group"
          orientation="horizontal"
          defaultLayout={{ 'editor-main': 70, 'terminal-column': 0, 'agents-column': 30 }}
        >
          <ResizablePanel id="editor-main" minSize="5%" />
          <ResizableHandle />
          <ResizablePanel id="terminal-column" minSize="0%" maxSize="0%">
            Terminal
          </ResizablePanel>
          <ResizableHandle aria-label="Agents" aria-controls="agents-column" />
          <ResizablePanel
            id="agents-column"
            minSize="0%"
            maxSize="95%"
            collapsible
            collapsedSize="0%"
          >
            Agents
          </ResizablePanel>
        </ResizablePanelGroup>,
      );

      const separator = view.getByRole('separator', { name: 'Agents' });
      expect.soft(separator.getAttribute('aria-controls')).toBe('agents-column');
      const primaryPane = view.container.querySelector('#agents-column');
      if (!(primaryPane instanceof HTMLElement)) throw new Error('primary pane not found');
      const hiddenTerminal = view.container.querySelector('#terminal-column');
      if (!(hiddenTerminal instanceof HTMLElement)) throw new Error('hidden terminal not found');
      expect(primaryPane.textContent).toBe('Agents');
      expect(Number(hiddenTerminal.style.flexGrow)).toBe(0);

      const valueMin = Number(separator.getAttribute('aria-valuemin'));
      const valueNow = Number(separator.getAttribute('aria-valuenow'));
      const valueMax = Number(separator.getAttribute('aria-valuemax'));
      expect.soft(valueMin).toBeLessThan(valueMax);
      expect.soft(valueNow).toBeGreaterThanOrEqual(valueMin);
      expect.soft(valueNow).toBeLessThanOrEqual(valueMax);
      expect.soft(valueNow).toBe(Number(primaryPane.style.flexGrow));

      const previousAgentsSize = Number(primaryPane.style.flexGrow);
      fireEvent.keyDown(separator, { key: 'ArrowLeft' });
      expect(Number(primaryPane.style.flexGrow)).toBeGreaterThan(previousAgentsSize);
      expect(Number(hiddenTerminal.style.flexGrow)).toBe(0);
      expect(separator.getAttribute('aria-valuenow')).toBe(primaryPane.style.flexGrow);

      fireEvent.keyDown(separator, { key: 'Home' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMin);
      fireEvent.keyDown(separator, { key: 'End' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMax);
      fireEvent.keyDown(separator, { key: 'Enter' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMin);
      fireEvent.keyDown(separator, { key: 'Enter' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMax);
    } finally {
      offsetLeft.mockRestore();
      offsetWidth.mockRestore();
    }
  });

  test('the terminal-visible separator reports and keyboard-resizes the Terminal pane', () => {
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function () {
        if (this.id === 'editor-main') return 200;
        if (this.id === 'terminal-column') return 500;
        if (this.id === 'agents-column') return 300;
        return 0;
      });
    const offsetLeft = vi
      .spyOn(HTMLElement.prototype, 'offsetLeft', 'get')
      .mockImplementation(function () {
        if (this.id === 'terminal-column') return 201;
        if (this.id === 'agents-column') return 702;
        if (this.hasAttribute('data-separator')) {
          const separators = [...(this.parentElement?.querySelectorAll('[data-separator]') ?? [])];
          return separators.indexOf(this) === 0 ? 200 : 701;
        }
        return 0;
      });
    try {
      const view = render(
        <ResizablePanelGroup
          id="terminal-visible-aria-group"
          orientation="horizontal"
          defaultLayout={{ 'editor-main': 20, 'terminal-column': 50, 'agents-column': 30 }}
        >
          <ResizablePanel id="editor-main" minSize="20%" maxSize="20%" />
          <ResizableHandle />
          <ResizablePanel
            id="terminal-column"
            minSize="0%"
            maxSize="70%"
            collapsible
            collapsedSize="0%"
          >
            Terminal
          </ResizablePanel>
          <ResizableHandle aria-label="Terminal" aria-controls="terminal-column" />
          <ResizablePanel id="agents-column" minSize="10%" maxSize="80%">
            Agents
          </ResizablePanel>
        </ResizablePanelGroup>,
      );

      const separator = view.getByRole('separator', { name: 'Terminal' });
      expect.soft(separator.getAttribute('aria-controls')).toBe('terminal-column');
      const editorPane = view.container.querySelector('#editor-main');
      if (!(editorPane instanceof HTMLElement)) throw new Error('editor pane not found');
      const primaryPane = view.container.querySelector('#terminal-column');
      if (!(primaryPane instanceof HTMLElement)) throw new Error('primary pane not found');
      const agentsPane = view.container.querySelector('#agents-column');
      if (!(agentsPane instanceof HTMLElement)) throw new Error('agents pane not found');
      expect(primaryPane.textContent).toBe('Terminal');

      const valueMin = Number(separator.getAttribute('aria-valuemin'));
      const valueNow = Number(separator.getAttribute('aria-valuenow'));
      const valueMax = Number(separator.getAttribute('aria-valuemax'));
      expect.soft(valueMin).toBeLessThan(valueMax);
      expect.soft(valueNow).toBeGreaterThanOrEqual(valueMin);
      expect.soft(valueNow).toBeLessThanOrEqual(valueMax);
      expect.soft(valueNow).toBe(Number(primaryPane.style.flexGrow));

      const previousTerminalSize = Number(primaryPane.style.flexGrow);
      const previousAgentsSize = Number(agentsPane.style.flexGrow);
      fireEvent.keyDown(separator, { key: 'ArrowRight' });
      expect(Number(primaryPane.style.flexGrow)).toBe(previousTerminalSize + 5);
      expect(Number(agentsPane.style.flexGrow)).toBe(previousAgentsSize - 5);
      expect(Number(editorPane.style.flexGrow)).toBe(20);
      expect(separator.getAttribute('aria-valuenow')).toBe(primaryPane.style.flexGrow);

      fireEvent.keyDown(separator, { key: 'Home' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMin);
      expect(Number(agentsPane.style.flexGrow)).toBe(80);
      expect(Number(editorPane.style.flexGrow)).toBe(20);
      fireEvent.keyDown(separator, { key: 'End' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMax);
      expect(Number(agentsPane.style.flexGrow)).toBe(10);
      expect(Number(editorPane.style.flexGrow)).toBe(20);
      fireEvent.keyDown(separator, { key: 'Enter' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMin);
      expect(Number(agentsPane.style.flexGrow)).toBe(80);
      expect(Number(editorPane.style.flexGrow)).toBe(20);
      fireEvent.keyDown(separator, { key: 'Enter' });
      expect(Number(primaryPane.style.flexGrow)).toBe(valueMax);
      expect(Number(agentsPane.style.flexGrow)).toBe(10);
      expect(Number(editorPane.style.flexGrow)).toBe(20);
    } finally {
      offsetLeft.mockRestore();
      offsetWidth.mockRestore();
    }
  });

  test('a panel rendered straight from the library still counts toward the panel space', () => {
    const view = render(
      <div data-editor-area-panels="">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="editor-main" defaultSize="50%" />
          <ResizableHandle />
          <ResizablePrimitive.Panel id="terminal-column" defaultSize="50%" />
        </ResizablePanelGroup>
      </div>,
    );
    const container = view.container.querySelector('[data-editor-area-panels]');
    if (!(container instanceof HTMLElement)) throw new Error('rail container not found');
    const terminalPanel = container.querySelector('#terminal-column');
    if (!(terminalPanel instanceof HTMLElement)) throw new Error('terminal panel not found');
    expect(terminalPanel.getAttribute('data-slot')).toBeNull();

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
