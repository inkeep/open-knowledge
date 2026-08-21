/**
 * RTL behavioral tests for Mermaid diagram controls.
 *
 * Mermaid and Panzoom are both lazy browser-side dependencies in the component.
 * These tests mock them at the module boundary so the contract under test is
 * the mounted toolbar behavior, filling preview layout, and Panzoom lifecycle.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

const renderMermaid = vi.fn(async (_id: string, _chart: string) => ({
  svg: '<svg viewBox="0 0 100 100"><g><text>Graph</text></g></svg>',
}));
const initializeMermaid = vi.fn(() => {});

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('mermaid', () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type MockPanzoomInstance = {
  zoomIn: ReturnType<typeof vi.fn>;
  zoomOut: ReturnType<typeof vi.fn>;
  pan: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  zoomWithWheel: ReturnType<typeof vi.fn>;
  getScale: ReturnType<typeof vi.fn>;
};
type MockPanzoomOptions = {
  cursor?: string;
  noBind?: boolean;
  touchAction?: string;
};

const panzoomInstances: MockPanzoomInstance[] = [];
const panzoomOptions: MockPanzoomOptions[] = [];
const createPanzoom = vi.fn((_element: SVGElement, options?: MockPanzoomOptions) => {
  const instance: MockPanzoomInstance = {
    zoomIn: vi.fn(() => ({ scale: 1.25 })),
    zoomOut: vi.fn(() => ({ scale: 0.75 })),
    pan: vi.fn(() => ({ x: 0, y: 0, scale: 1 })),
    reset: vi.fn(() => ({ x: 0, y: 0, scale: 1 })),
    destroy: vi.fn(() => {}),
    zoomWithWheel: vi.fn(() => ({ scale: 1 })),
    getScale: vi.fn(() => 1),
  };
  panzoomInstances.push(instance);
  panzoomOptions.push(options ?? {});
  return instance;
});

vi.doMock('@panzoom/panzoom', () => ({
  default: createPanzoom,
}));

const { MermaidView } = await import('./Mermaid');
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
    const warn = vi.fn(() => {});
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

  test('standalone .mmd binding wires two-finger wheel to pan and ctrl/meta+wheel to zoom', async () => {
    const editBinding = { canEdit: true, commitChart: vi.fn() };
    const { container } = render(
      <TooltipProvider>
        <MermaidView chart="graph TD; A-->B;" editBinding={editBinding} />
      </TooltipProvider>,
    );

    const panzoom = await waitForPanzoomInstance();
    const scroller = container.querySelector('.ok-mermaid-svg') as HTMLElement;
    expect(scroller).not.toBeNull();

    const trackpad = new WheelEvent('wheel', {
      deltaX: 30,
      deltaY: 40,
      bubbles: true,
      cancelable: true,
    });
    scroller.dispatchEvent(trackpad);
    expect(panzoom.pan).toHaveBeenCalledWith(-30, -40, { relative: true });
    expect(panzoom.zoomWithWheel).not.toHaveBeenCalled();
    expect(trackpad.defaultPrevented).toBe(true);

    // Scale-compensated: at 2x zoom, a 60px wheel delta pans 30 local units
    // so the visible content tracks the gesture 1:1.
    panzoom.pan.mockClear();
    panzoom.getScale.mockReturnValueOnce(2);
    const scaled = new WheelEvent('wheel', {
      deltaX: 60,
      deltaY: 0,
      bubbles: true,
      cancelable: true,
    });
    scroller.dispatchEvent(scaled);
    expect(panzoom.pan).toHaveBeenCalledWith(-30, -0, { relative: true });

    const zoom = new WheelEvent('wheel', {
      deltaY: -10,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    scroller.dispatchEvent(zoom);
    expect(panzoom.zoomWithWheel).toHaveBeenCalledWith(zoom);
    expect(zoom.defaultPrevented).toBe(true);

    panzoom.zoomWithWheel.mockClear();
    const cmdZoom = new WheelEvent('wheel', {
      deltaY: -10,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    scroller.dispatchEvent(cmdZoom);
    expect(panzoom.zoomWithWheel).toHaveBeenCalledWith(cmdZoom);
    expect(cmdZoom.defaultPrevented).toBe(true);
  });

  test('standalone wheel listener does not accumulate across re-renders', async () => {
    const editBinding = { canEdit: true, commitChart: vi.fn() };
    const { container, rerender } = render(
      <TooltipProvider>
        <MermaidView chart="graph TD; A-->B;" editBinding={editBinding} />
      </TooltipProvider>,
    );
    const first = await waitForPanzoomInstance();

    rerender(
      <TooltipProvider>
        <MermaidView chart="graph TD; B-->C;" editBinding={editBinding} />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(panzoomInstances.length).toBe(2);
      expect(first.destroy.mock.calls.length).toBe(1);
    });
    const current = panzoomInstances[1];

    const scroller = container.querySelector('.ok-mermaid-svg') as HTMLElement;
    const wheel = new WheelEvent('wheel', {
      deltaX: 10,
      deltaY: 20,
      bubbles: true,
      cancelable: true,
    });
    scroller.dispatchEvent(wheel);
    // The wheel binding must fire on the CURRENT panzoom exactly once,
    // never on the destroyed prior instance, no matter how many renders
    // have fired between mount and now.
    expect(current.pan.mock.calls.length).toBe(1);
    expect(first.pan.mock.calls.length).toBe(0);
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
