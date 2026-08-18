import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

// Regression guard for the phantom-column paint: the terminal-right
// and agents rail columns are permanent members of the resizable group (the
// mount/unmount layout-cache bug we work around elsewhere), and while hidden
// they must not be able to hold a non-zero flex share for even one
// redistribute-then-reclaim frame. RRP's own `validatePanelSize` applies
// `Math.min(maxSize, size)` LAST (after the collapsible halfway snap), so a
// `maxSize` of `0px` hard-clamps every layout pass to zero even though
// `minSize` still declares the natural width for when the column comes back.
//
// The counter-test below documents the shape that DOES NOT hold the flex
// share to zero — a hidden panel carrying `style={{ display: 'none' }}` alone.
// RRP's `Panel` spreads `style` onto its inner content div; the outer
// `data-panel` flex item that carries the group-computed `flexGrow` keeps
// `display: flex` hardcoded and accepts whatever share `setLayout` assigns.
// If a future refactor drops `maxSize` and leans on `style` again, the first
// test flips green→red and the counter-test flips red→green in one commit.

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

function ClampedRailGroup() {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: 1200 }}>
      <Panel id="editor" minSize="10%">
        editor
      </Panel>
      <Separator />
      <Panel
        id="hidden-rail"
        defaultSize={0}
        minSize="320px"
        maxSize="0px"
        collapsible
        collapsedSize={0}
      >
        hidden
      </Panel>
    </Group>
  );
}

function PresenceToggleRailGroup({ present }: { present: boolean }) {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: 1200 }}>
      <Panel id="editor" minSize="10%">
        editor
      </Panel>
      <Separator />
      <Panel
        id="toggle-rail"
        defaultSize={present ? '400px' : 0}
        minSize="320px"
        maxSize={present ? undefined : '0px'}
        collapsible
        collapsedSize={0}
      >
        toggleable
      </Panel>
    </Group>
  );
}

function StyleHiddenRailGroup() {
  const groupRef = useGroupRef();
  capturedGroupRef = groupRef;
  return (
    <Group orientation="horizontal" groupRef={groupRef} style={{ width: 1200 }}>
      <Panel id="editor" minSize="10%">
        editor
      </Panel>
      <Separator />
      <Panel
        id="hidden-rail"
        defaultSize={0}
        minSize="320px"
        collapsible
        collapsedSize={0}
        style={{ display: 'none' }}
      >
        hidden
      </Panel>
    </Group>
  );
}

describe('hidden rail column cannot hold non-zero flex share', () => {
  test('maxSize="0px" hard-clamps a hidden column to zero share after setLayout', async () => {
    await withOffsetWidth(1200, async () => {
      await act(async () => {
        render(<ClampedRailGroup />);
      });
      const group = capturedGroupRef?.current;
      if (!group) throw new Error('group imperative handle was not attached');

      // Baseline: at mount the hidden panel already sits at 0.
      const initial = group.getLayout();
      expect(initial['hidden-rail']).toBeCloseTo(0, 1);
      expect(initial.editor).toBeCloseTo(100, 1);

      // Try to hand the hidden column a real share the way a proportional
      // redistribute would — the frame the original bug painted in.
      await act(async () => {
        group.setLayout({ editor: 73, 'hidden-rail': 27 });
      });

      const recovered = group.getLayout();

      // If `maxSize` did not clamp, `hidden-rail` would come back as 27
      // (or as `minSize`-clamped 320px≈26.67%) and paint an empty gap.
      expect(recovered['hidden-rail']).toBeCloseTo(0, 1);
      expect(recovered.editor).toBeCloseTo(100, 1);

      // And the outer `[data-panel]` flex item — the one that actually holds
      // `flexGrow` — reflects the clamp. This is the DOM axis the panel-half
      // of a `style={{display:'none'}}` fix cannot influence, since Panel
      // spreads `style` onto its inner content div.
      const hiddenPanel = document.querySelector<HTMLElement>('[data-panel][id="hidden-rail"]');
      if (!hiddenPanel) throw new Error('hidden panel outer div was not rendered');
      const flexGrow = hiddenPanel.style.flexGrow;
      // RRP writes `flexGrow` as a string on the outer div's inline style.
      // An empty string means the panel is not being expanded at all — which
      // is what we want. Any positive number means the phantom can paint.
      expect(flexGrow === '' || Number(flexGrow) === 0).toBe(true);
    });
  });

  test('present arm: lifting maxSize lets the same panel accept a non-zero share', async () => {
    // The visible-arm counterpart. Without this an accidental inversion of
    // the conditional (`maxSize` returning `'0px'` even while present) would
    // still keep both other tests green — the hidden-clamp test would pass
    // by construction and the counter-test below is on a separate config.
    // Here the same panel starts hidden (clamped) and transitions to present
    // (unclamped) between renders; the assertion is that once `maxSize` is
    // lifted the panel actually accepts the share `setLayout` assigns.
    await withOffsetWidth(1200, async () => {
      const { rerender } = await (async () => {
        let handle: ReturnType<typeof render> | undefined;
        await act(async () => {
          handle = render(<PresenceToggleRailGroup present={false} />);
        });
        if (!handle) throw new Error('render did not complete');
        return handle;
      })();

      const group = capturedGroupRef?.current;
      if (!group) throw new Error('group imperative handle was not attached');

      // Baseline while hidden — maxSize="0px" clamps regardless of layout ask.
      await act(async () => {
        group.setLayout({ editor: 73, 'toggle-rail': 27 });
      });
      expect(group.getLayout()['toggle-rail']).toBeCloseTo(0, 1);

      // Flip present=true — maxSize lifts to undefined. The same panel that
      // was pinned at 0 must now accept a real share.
      await act(async () => {
        rerender(<PresenceToggleRailGroup present />);
      });
      await act(async () => {
        group.setLayout({ editor: 60, 'toggle-rail': 40 });
      });

      const recovered = group.getLayout();
      expect(recovered['toggle-rail']).toBeGreaterThan(10);
      expect(recovered.editor + recovered['toggle-rail']).toBeCloseTo(100, 1);
    });
  });

  test('style={{ display: "none" }} alone does NOT clamp a hidden column to zero share', async () => {
    // Counter-test — documents the mechanism the earlier attempt missed. If
    // this ever starts passing, RRP began spreading `style` onto the outer
    // `data-panel` div and the `maxSize` clamp above is no longer the only
    // path — but until then, `style` alone cannot carry this fix.
    await withOffsetWidth(1200, async () => {
      await act(async () => {
        render(<StyleHiddenRailGroup />);
      });
      const group = capturedGroupRef?.current;
      if (!group) throw new Error('group imperative handle was not attached');

      await act(async () => {
        group.setLayout({ editor: 73, 'hidden-rail': 27 });
      });

      const recovered = group.getLayout();
      // The hidden column keeps a real share — this is the phantom-paint window.
      expect(recovered['hidden-rail']).toBeGreaterThan(0);
    });
  });
});
