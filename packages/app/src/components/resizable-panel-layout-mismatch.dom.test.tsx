import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

// Regression guard for the app-shell crash reported when the set of open side
// panels changed: react-resizable-panels' internal `validatePanelGroupLayout`
// threw `Invalid <n> panel layout: ...` whenever a layout's entry count did not
// match the number of currently-mounted panels. It throws during render, so it
// tripped the app error boundary and took down the whole window.
//
// We patch the library (patches/react-resizable-panels@4.12.1.patch) so a
// panel-count mismatch rebuilds a valid layout for the panels actually present
// instead of throwing.
//
// Scope note: this drives the validator through the imperative `setLayout`
// path. The library reaches the same function from two other directions (its
// ResizeObserver resize path and its per-panel-set layout-cache restore) that
// are not directly exercised here — all three funnel through the one patched
// function, but an upstream change that added a guard BEFORE it could
// re-introduce the crash on those paths while this test stayed green. Worth
// re-checking on the next dependency bump.

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

      // A 3-entry layout (mirrors the reported "Invalid 2 panel layout:
      // 59.477%, 15.503%, 25.02%") — the shape produced when a conditionally
      // rendered panel unmounts and the group's layout cache serves the
      // pre-unmount entry back. Before the patch this threw synchronously.
      const staleThreePanelLayout: Record<string, number> = {
        [firstId]: 59.477,
        [secondId]: 15.503,
        phantom: 25.02,
      };

      await act(async () => {
        expect(() => group.setLayout(staleThreePanelLayout)).not.toThrow();
      });

      const recovered = group.getLayout();

      // Keyed by the panels that actually exist — asserting the id set, not
      // just the count, so a recovery that carried the `phantom` key through
      // (or invented ids) cannot pass.
      expect(Object.keys(recovered).sort()).toEqual([firstId, secondId].sort());

      const total = Object.values(recovered).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(100, 1);

      // Recovery honors each panel's declared `defaultSize` rather than
      // flattening to an even split. This is the assertion that distinguishes
      // reusing the library's own default-layout builder from a hand-rolled
      // `100 / count` rebuild: the latter would hand both panels 50%, silently
      // discarding widths the app restores from its width store.
      const docId = secondId as string;
      expect(recovered[docId]).toBeCloseTo(DOC_PANEL_DEFAULT_PCT, 1);
      expect(recovered[firstId as string]).toBeCloseTo(100 - DOC_PANEL_DEFAULT_PCT, 1);
    });
  });
});
