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

const DOC_PANEL_DEFAULT_PCT = 20;

function TwoPanelGroup() {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: 900 }}>
      <Panel minSize="10%">editor</Panel>
      <Separator />
      <Panel id="doc" minSize="10%" defaultSize={`${DOC_PANEL_DEFAULT_PCT}%`}>
        doc
      </Panel>
    </Group>
  );
}

describe('react-resizable-panels layout-count mismatch is not fatal', () => {
  test('a stale 3-entry layout applied to a 2-panel group does not throw', async () => {
    await withOffsetWidth(300, async () => {
      await act(async () => {
        render(<TwoPanelGroup />);
      });
      const group = capturedGroupRef?.current;
      if (!group) throw new Error('group imperative handle was not attached');

      const [firstId, secondId, ...rest] = Object.keys(group.getLayout());
      expect(rest).toHaveLength(0);
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();

      const staleThreePanelLayout: Record<string, number> = {
        [firstId]: 59.477,
        [secondId]: 15.503,
        phantom: 25.02,
      };

      await act(async () => {
        expect(() => group.setLayout(staleThreePanelLayout)).not.toThrow();
      });

      const recovered = group.getLayout();

      expect(Object.keys(recovered).sort()).toEqual([firstId, secondId].sort());

      const total = Object.values(recovered).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(100, 1);

      const docId = secondId as string;
      expect(recovered[docId]).toBeCloseTo(DOC_PANEL_DEFAULT_PCT, 1);
      expect(recovered[firstId as string]).toBeCloseTo(100 - DOC_PANEL_DEFAULT_PCT, 1);
    });
  });
});
