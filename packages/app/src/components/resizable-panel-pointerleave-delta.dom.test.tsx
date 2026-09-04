import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
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

afterEach(() => {
  cleanup();
  capturedGroupRef = null;
});

const PANEL_WIDTH = 450;
const GROUP_SIZE = PANEL_WIDTH * 2;
const RIGHT_DEFAULT_PCT = 40;
const TRAVEL_PX = 90;
const TRAVEL_PCT = (TRAVEL_PX / GROUP_SIZE) * 100;

function CollapsibleRightGroup() {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
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
      >
        right
      </Panel>
    </Group>
  );
}

function pointerEvent(type: string, init: MouseEventInit) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

describe('react-resizable-panels applies the real drag delta on pointerleave', () => {
  test('a mid-drag pointerleave resizes by the travelled distance, never the whole group', async () => {
    await withOffsetWidth(PANEL_WIDTH, async () => {
      await act(async () => {
        render(<CollapsibleRightGroup />);
      });
      const group = capturedGroupRef?.current;
      if (!group) throw new Error('group imperative handle was not attached');

      const separator = document.querySelector('[data-separator]');
      if (!separator) throw new Error('separator element was not rendered');

      expect(group.getLayout().right).toBeCloseTo(RIGHT_DEFAULT_PCT, 1);

      await act(async () => {
        separator.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 }));
      });

      await act(async () => {
        document.dispatchEvent(
          pointerEvent('pointerleave', {
            clientX: TRAVEL_PX,
            clientY: 0,
            movementX: TRAVEL_PX,
            movementY: 0,
          }),
        );
      });

      const right = group.getLayout().right;

      expect(right).toBeGreaterThan(0);

      expect(right).toBeCloseTo(RIGHT_DEFAULT_PCT - TRAVEL_PCT, 1);
    });
  });
});
