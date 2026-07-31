import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

// Regression guard for the app-shell crash reported when a user closed the
// right chat panel: react-resizable-panels' internal
// `validatePanelGroupLayout` threw `Invalid <n> panel layout: ...` whenever a
// layout's entry count did not match the number of currently-mounted panels.
// The throw is reachable from the library's own ResizeObserver resize path and
// its per-panel-set layout-cache restore during conditional rendering, so it
// surfaced as an uncaught render-time error and tripped the app error boundary.
//
// We patch the library (patches/react-resizable-panels@4.12.1.patch) so a
// panel-count mismatch is recovered (an even default is rebuilt for the current
// panels) instead of thrown. This test drives the real (patched) library
// through the same `validatePanelGroupLayout` path that crashed.

function withOffsetWidth(px: number, fn: () => Promise<void>) {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => px });
  const restore = () => {
    if (original) Object.defineProperty(proto, 'offsetWidth', original);
    else delete (proto as unknown as Record<string, unknown>).offsetWidth;
  };
  return fn().finally(restore);
}

afterEach(cleanup);

let capturedGroupRef: ReturnType<typeof useGroupRef> | null = null;
function TwoPanelGroup() {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: 900 }}>
      <Panel minSize="10%">editor</Panel>
      <Separator />
      <Panel id="doc" minSize="10%" defaultSize="20%">
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

      // A 3-entry layout (mirrors the reported "Invalid 2 panel layout:
      // 59.477%, 15.503%, 25.02%") — the crash the user hit when the right
      // panel unmounted mid-reconcile. Before the patch this threw synchronously
      // inside validatePanelGroupLayout.
      const staleThreePanelLayout: Record<string, number> = {
        [firstId]: 59.477,
        [secondId]: 15.503,
        phantom: 25.02,
      };

      expect(() => group.setLayout(staleThreePanelLayout)).not.toThrow();

      // The group recovers to a valid two-panel layout summing to ~100.
      const recovered = group.getLayout();
      expect(Object.keys(recovered)).toHaveLength(2);
      const total = Object.values(recovered).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(100, 1);
    });
  });
});
