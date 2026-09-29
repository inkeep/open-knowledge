import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef, usePanelRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';

function withOffsetWidth(px: number, fn: () => Promise<void>) {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => px });
  const restore = () => {
    if (original) Object.defineProperty(proto, 'offsetWidth', original);
    else Reflect.deleteProperty(proto, 'offsetWidth');
  };
  return fn().finally(restore);
}

function withMeasuredOffsetWidth(groupPx: number, fn: () => Promise<void>) {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-group')) return groupPx;
      if (!this.hasAttribute('data-panel')) return 0;
      return (Number.parseFloat(this.style.flexGrow || '0') / 100) * groupPx;
    },
  });
  const restore = () => {
    if (original) Object.defineProperty(proto, 'offsetWidth', original);
    else Reflect.deleteProperty(proto, 'offsetWidth');
  };
  return fn().finally(restore);
}

let capturedGroupRef: ReturnType<typeof useGroupRef> | null = null;
let capturedPanelRef: ReturnType<typeof usePanelRef> | null = null;

afterEach(() => {
  cleanup();
  capturedGroupRef = null;
  capturedPanelRef = null;
});

const GROUP_SIZE = 900;
const RIGHT_DEFAULT_PCT = 40;
const COLLAPSE_TRAVEL_PX = GROUP_SIZE;

function CollapsibleRightGroup() {
  const groupRef = useGroupRef();
  const panelRef = usePanelRef();
  capturedGroupRef = groupRef;
  capturedPanelRef = panelRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: GROUP_SIZE }}>
      <Panel id="editor" minSize="10%">
        editor
      </Panel>
      <Separator />
      <Panel
        id="right"
        collapsible
        collapsedSize={0}
        minSize="20%"
        defaultSize={`${RIGHT_DEFAULT_PCT}%`}
        panelRef={panelRef}
      >
        right
      </Panel>
    </Group>
  );
}

function FluidCollapsibleRightGroup() {
  const groupRef = useGroupRef();
  const panelRef = usePanelRef();
  capturedGroupRef = groupRef;
  capturedPanelRef = panelRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: 1200 }}>
      <Panel id="editor" minSize="10%" defaultSize="60%">
        editor
      </Panel>
      <Separator />
      <Panel
        id="hidden-terminal"
        collapsible
        collapsedSize={0}
        minSize="0px"
        maxSize="0px"
        defaultSize={0}
      >
        terminal
      </Panel>
      <Separator />
      <Panel
        id="right"
        collapsible
        collapsedSize={0}
        minSize="0px"
        defaultSize="40%"
        panelRef={panelRef}
      >
        right
      </Panel>
    </Group>
  );
}

function ProductionResizableContractGroup() {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
  return (
    <div data-editor-area-panels="">
      <ResizablePanelGroup
        orientation="horizontal"
        groupRef={groupRef}
        style={{ width: GROUP_SIZE }}
      >
        <ResizablePanel id="editor-contract" defaultSize="60%">
          editor
        </ResizablePanel>
        <ResizableHandle data-agents-panel-resize-handle="" />
        <ResizablePanel id="agents-contract" defaultSize="40%">
          agents
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function pointerEvent(type: string, init: MouseEventInit) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

describe('react-resizable-panels collapse observable the showing-hold mock assumes', () => {
  test('production wrappers preserve the focused keyboard handle marker and direct panel shape', async () => {
    await withOffsetWidth(GROUP_SIZE, async () => {
      await act(async () => {
        render(<ProductionResizableContractGroup />);
      });

      const container = document.querySelector('[data-editor-area-panels]');
      const group = container?.firstElementChild;
      if (!(group instanceof HTMLElement)) throw new Error('panel group was not rendered');
      expect(group.dataset.slot).toBe('resizable-panel-group');

      const handle = group.querySelector<HTMLElement>('[data-agents-panel-resize-handle]');
      if (handle == null) throw new Error('agents resize handle marker was not forwarded');
      act(() => handle.focus());
      expect(document.activeElement).toBe(handle);
      expect(document.activeElement?.getAttribute('data-slot')).toBe('resizable-handle');

      const groupApi = capturedGroupRef?.current;
      if (groupApi == null) throw new Error('group imperative handle was not attached');
      const floorPercentage = (320 / GROUP_SIZE) * 100;
      act(() => {
        groupApi.setLayout({ 'editor-contract': 70, 'agents-contract': 30 });
      });
      expect(groupApi.getLayout()['agents-contract']).toBe(30);
      act(() => {
        groupApi.setLayout({
          'editor-contract': 100 - floorPercentage,
          'agents-contract': floorPercentage,
        });
      });
      expect(groupApi.getLayout()['agents-contract']).toBeCloseTo(floorPercentage, 3);
      expect(document.activeElement).toBe(handle);

      const panelIds = [...group.children]
        .filter((element) => element.getAttribute('data-slot') === 'resizable-panel')
        .map((element) => element.id);
      expect(panelIds).toEqual(['editor-contract', 'agents-contract']);
    });
  });

  test('a real drag that dips the right panel to measured collapse still reads collapsed at pointercancel and releases on a drag-free expansion', async () => {
    await withOffsetWidth(GROUP_SIZE, async () => {
      await act(async () => {
        render(<CollapsibleRightGroup />);
      });
      const group = capturedGroupRef?.current;
      const panel = capturedPanelRef?.current;
      if (!group || !panel) throw new Error('imperative handles were not attached');

      const separator = document.querySelector('[data-separator]');
      if (!separator) throw new Error('separator element was not rendered');

      expect(panel.isCollapsed()).toBe(false);

      await act(async () => {
        separator.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 }));
      });
      await act(async () => {
        document.dispatchEvent(
          pointerEvent('pointerleave', { clientX: COLLAPSE_TRAVEL_PX, clientY: 0 }),
        );
      });

      expect(group.getLayout().right).toBe(0);
      expect(panel.isCollapsed()).toBe(true);

      await act(async () => {
        document.dispatchEvent(
          pointerEvent('pointercancel', { clientX: COLLAPSE_TRAVEL_PX, clientY: 0 }),
        );
      });

      expect(group.getLayout().right).toBe(0);
      expect(panel.isCollapsed()).toBe(true);

      await act(async () => {
        panel.expand();
      });

      expect(group.getLayout().right).toBeGreaterThan(0);
      expect(panel.isCollapsed()).toBe(false);
    });
  });

  test('a zero-minimum right panel follows shrink and reverse pointer travel below 320px', async () => {
    await withMeasuredOffsetWidth(1200, async () => {
      await act(async () => {
        render(<FluidCollapsibleRightGroup />);
      });
      const group = capturedGroupRef?.current;
      if (!group) throw new Error('group imperative handle was not attached');
      const separator = document.querySelectorAll('[data-separator]').item(1);
      if (!separator) throw new Error('separator element was not rendered');
      const widthPx = () => ((group.getLayout().right ?? 0) / 100) * 1200;

      expect(widthPx()).toBeCloseTo(480, 0);
      await act(async () => {
        separator.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 }));
      });
      await act(async () => {
        document.dispatchEvent(
          pointerEvent('pointermove', { clientX: -145, clientY: 0, buttons: 1 }),
        );
      });
      expect(widthPx()).toBeCloseTo(335, 0);
      await act(async () => {
        document.dispatchEvent(
          pointerEvent('pointermove', { clientX: -190, clientY: 0, buttons: 1 }),
        );
      });
      expect(widthPx()).toBeCloseTo(290, 0);
      await act(async () => {
        document.dispatchEvent(
          pointerEvent('pointermove', { clientX: -110, clientY: 0, buttons: 1 }),
        );
      });
      expect(widthPx()).toBeCloseTo(370, 0);
      await act(async () => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: -110, clientY: 0 }));
      });
    });
  });
});
