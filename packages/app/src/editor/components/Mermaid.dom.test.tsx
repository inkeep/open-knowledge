/**
 * RTL behavioral tests for Mermaid diagram controls.
 *
 * Mermaid and Panzoom are both lazy browser-side dependencies in the component.
 * These tests mock them at the module boundary so the contract under test is
 * the mounted toolbar behavior, filling preview layout, and Panzoom lifecycle.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const renderMermaid = mock(async (_id: string, _chart: string) => ({
  svg: '<svg viewBox="0 0 100 100"><g><text>Graph</text></g></svg>',
}));
const initializeMermaid = mock(() => {});

mock.module('mermaid', () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}));

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type MockPanzoomInstance = {
  zoomIn: ReturnType<typeof mock>;
  zoomOut: ReturnType<typeof mock>;
  pan: ReturnType<typeof mock>;
  reset: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
  zoomWithWheel: ReturnType<typeof mock>;
};
type MockPanzoomOptions = {
  cursor?: string;
  noBind?: boolean;
  touchAction?: string;
};

const panzoomInstances: MockPanzoomInstance[] = [];
const panzoomOptions: MockPanzoomOptions[] = [];
const createPanzoom = mock((_element: SVGElement, options?: MockPanzoomOptions) => {
  const instance: MockPanzoomInstance = {
    zoomIn: mock(() => ({ scale: 1.25 })),
    zoomOut: mock(() => ({ scale: 0.75 })),
    pan: mock(() => ({ x: 0, y: 0, scale: 1 })),
    reset: mock(() => ({ x: 0, y: 0, scale: 1 })),
    destroy: mock(() => {}),
    zoomWithWheel: mock(() => ({ scale: 1 })),
  };
  panzoomInstances.push(instance);
  panzoomOptions.push(options ?? {});
  return instance;
});

mock.module('@panzoom/panzoom', () => ({
  default: createPanzoom,
}));

const { MermaidView, flashLinkedLabels, collectLinkedLabelTargets } = await import('./Mermaid');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderMermaidView(chart: string) {
  return render(
    <TooltipProvider>
      <MermaidView chart={chart} />
    </TooltipProvider>,
  );
}

async function waitForPanzoomInstance(index = 0) {
  await waitFor(() => {
    expect(panzoomInstances.length).toBeGreaterThan(index);
  });
  return panzoomInstances[index];
}

describe('MermaidView controls', () => {
  beforeEach(() => {
    renderMermaid.mockClear();
    initializeMermaid.mockClear();
    createPanzoom.mockClear();
    panzoomInstances.length = 0;
    panzoomOptions.length = 0;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test('renders toolbar buttons for a ready diagram', async () => {
    renderMermaidView('graph TD; A-->B;');

    for (const label of [
      'Zoom in',
      'Zoom out',
      'Pan up',
      'Pan down',
      'Pan left',
      'Pan right',
      'Reset view',
    ]) {
      expect(await screen.findByRole('button', { name: label })).not.toBeNull();
    }
  });

  test('labels the controls as a toolbar', async () => {
    renderMermaidView('graph TD; A-->B;');

    await waitForPanzoomInstance();

    expect(screen.getByRole('toolbar', { name: 'Mermaid diagram controls' })).not.toBeNull();
  });

  test('toolbar controls call the Panzoom instance', async () => {
    renderMermaidView('graph TD; A-->B;');
    const panzoom = await waitForPanzoomInstance();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan right' }));

    expect(panzoom.zoomIn.mock.calls.length).toBe(1);
    expect(panzoom.zoomOut.mock.calls.length).toBe(1);
    expect(panzoom.reset.mock.calls.length).toBe(1);
    expect(panzoom.pan.mock.calls).toEqual([
      [0, -48, { relative: true }],
      [0, 48, { relative: true }],
      [-48, 0, { relative: true }],
      [48, 0, { relative: true }],
    ]);
  });

  test('does not register wheel zoom listeners inside the diagram', async () => {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const addEventListenerCalls: Array<{ target: EventTarget; type: string }> = [];
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) {
      addEventListenerCalls.push({ target: this, type });
      return originalAddEventListener.call(this, type, listener, options);
    };

    try {
      renderMermaidView('graph TD; A-->B;');

      await waitForPanzoomInstance();

      const mermaidWheelListeners = addEventListenerCalls.filter(
        ({ target, type }) =>
          type === 'wheel' &&
          target instanceof Element &&
          target.closest('[data-component-type="mermaid"]'),
      );
      expect(mermaidWheelListeners).toHaveLength(0);
    } finally {
      EventTarget.prototype.addEventListener = originalAddEventListener;
    }
  });

  test('logs when Panzoom setup fails', async () => {
    const originalWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn;
    createPanzoom.mockImplementationOnce(() => {
      throw new Error('panzoom unavailable');
    });

    try {
      renderMermaidView('graph TD; A-->B;');

      await waitFor(() => {
        expect(warn.mock.calls.length).toBe(1);
      });
      expect(warn.mock.calls[0]?.[0]).toBe('[Mermaid] panzoom setup failed:');
      expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('does not bind pointer drag gestures to the diagram', async () => {
    renderMermaidView('graph TD; A-->B;');

    await waitForPanzoomInstance();

    expect(panzoomOptions[0]?.noBind).toBe(true);
    expect(panzoomOptions[0]?.cursor).toBe('default');
    expect(panzoomOptions[0]?.touchAction).toBe('auto');
  });

  test('re-rendering with a different chart destroys the old Panzoom instance', async () => {
    const { rerender } = render(
      <TooltipProvider>
        <MermaidView chart="graph TD; A-->B;" />
      </TooltipProvider>,
    );
    const firstPanzoom = await waitForPanzoomInstance();

    rerender(
      <TooltipProvider>
        <MermaidView chart="graph TD; B-->C;" />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(firstPanzoom.destroy.mock.calls.length).toBe(1);
      expect(panzoomInstances.length).toBe(2);
    });
  });

  test('ready diagram fills its preview host', async () => {
    const { container } = renderMermaidView('graph TD; A-->B;');

    await waitForPanzoomInstance();

    const root = container.querySelector<HTMLElement>('[data-component-type="mermaid"]');
    const svgHost = container.querySelector<HTMLElement>('.ok-mermaid-svg');
    const stage = svgHost?.parentElement;
    expect(root?.className).toContain('h-full');
    expect(root?.className).toContain('w-full');
    expect(svgHost?.className).toContain('flex-1');
    expect(stage?.className).not.toContain('p-4');
  });

  test('action cluster is compact and anchored bottom-right', async () => {
    const { container } = renderMermaidView('graph TD; A-->B;');

    await waitForPanzoomInstance();

    const cluster = screen.getByTestId('mermaid-actions');
    const resetButton = screen.getByRole('button', { name: 'Reset view' });
    const resetIcon = resetButton.querySelector('svg');
    expect(cluster?.className).toContain('right-3');
    expect(cluster?.className).toContain('bottom-3');
    expect(resetButton.getAttribute('data-size')).toBe('icon-sm');
    expect(resetIcon?.classList).toContain('size-4');
    expect(container.querySelector('.top-1\\/2')).toBeNull();
  });

  test('error state does not render toolbar controls', async () => {
    renderMermaid.mockImplementationOnce(async () => {
      throw new Error('invalid mermaid');
    });

    renderMermaidView('graph TD; A-->');

    expect(await screen.findByRole('alert')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
  });
});

describe('MermaidView editBinding (standalone .mmd path)', () => {
  test('renders an editable diagram with no JSX host when an editBinding is supplied', async () => {
    // The standalone `.mmd` doc path passes an `editBinding` and mounts OUTSIDE
    // any JsxComponentHost. The editable effect (canEdit=true) must run without a
    // host and without throwing; the diagram still renders its toolbar.
    let committed: string | null = null;
    render(
      <TooltipProvider>
        <MermaidView
          chart="graph TD; A-->B;"
          editBinding={{
            canEdit: true,
            getChart: () => 'graph TD; A-->B;',
            commitChart: (next) => {
              committed = next;
            },
          }}
        />
      </TooltipProvider>,
    );
    await waitForPanzoomInstance();
    expect(screen.getByRole('toolbar')).toBeDefined();
    // No label interaction happened, so the binding was not invoked.
    expect(committed).toBeNull();
  });
});

describe('flashLinkedLabels', () => {
  test('flashes every occurrence when a label appears 2+ times (linked)', () => {
    const c = document.createElement('div');
    c.innerHTML =
      '<svg><text class="actor">Test123</text></svg>' +
      '<svg><text class="actor">Test123</text></svg>' +
      '<span class="nodeLabel">Untouched</span>';
    expect(flashLinkedLabels(c, 'Test123')).toBe(2);
    expect(c.querySelectorAll('.mermaid-label-flash').length).toBe(2);
    // Non-matching label is left alone.
    expect(c.querySelector('.nodeLabel')?.classList.contains('mermaid-label-flash')).toBe(false);
  });

  test('stays quiet for a lone occurrence (no related text to signal)', () => {
    const c = document.createElement('div');
    c.innerHTML = '<span class="nodeLabel">Solo</span><span class="nodeLabel">Other</span>';
    expect(flashLinkedLabels(c, 'Solo')).toBe(0);
    expect(c.querySelector('.mermaid-label-flash')).toBeNull();
  });

  test('matches trimmed text and ignores blank values', () => {
    const c = document.createElement('div');
    c.innerHTML = '<text class="messageText">  Ping  </text><text class="messageText">Ping</text>';
    expect(flashLinkedLabels(c, 'Ping')).toBe(2);
    const blank = document.createElement('div');
    blank.innerHTML = '<text class="actor"> </text><text class="actor"> </text>';
    expect(flashLinkedLabels(blank, '   ')).toBe(0);
  });
});

describe('collectLinkedLabelTargets (live-preview matching)', () => {
  test('returns the other occurrences of the token, excluding the edited one', () => {
    const c = document.createElement('div');
    c.innerHTML =
      '<text class="actor" id="top">Alice</text>' +
      '<text class="actor" id="bottom">Alice</text>' +
      '<text class="messageText">Alice waves</text>'; // different text: not a match
    const edited = c.querySelector('#top') as Element;
    const targets = collectLinkedLabelTargets(c, 'Alice', [edited]);
    expect(targets.length).toBe(1);
    expect((targets[0] as Element).id).toBe('bottom');
  });

  test('excludes nested/ancestor elements of an excluded node (either direction)', () => {
    const c = document.createElement('div');
    // The edited node's own text nests a matching span; excluding the outer
    // must also drop the inner (and vice versa) so we never preview onto the
    // element being typed into.
    c.innerHTML = '<span class="nodeLabel"><span class="nodeLabel">Foo</span></span>';
    const outer = c.querySelector('.nodeLabel') as Element;
    expect(collectLinkedLabelTargets(c, 'Foo', [outer])).toEqual([]);
  });

  test('empty needle matches nothing', () => {
    const c = document.createElement('div');
    c.innerHTML = '<text class="actor"> </text><text class="actor"> </text>';
    expect(collectLinkedLabelTargets(c, '   ')).toEqual([]);
  });
});
