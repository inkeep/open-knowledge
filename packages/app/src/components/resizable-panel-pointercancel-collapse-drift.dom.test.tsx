import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef, usePanelRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

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
      {}
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

function pointerEvent(type: string, init: MouseEventInit) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

describe('react-resizable-panels collapse observable the showing-hold mock assumes', () => {
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
});
