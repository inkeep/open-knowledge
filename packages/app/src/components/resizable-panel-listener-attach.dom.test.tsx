import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

// Regression guard for panels that go permanently non-resizable mid-session.
//
// react-resizable-panels installs its global pointer handlers on the owner
// document from `mountGroup`, behind a reference count shared by every mounted
// group. Upstream the install is gated on the count being exactly 1 — but the
// count is incremented several statements BEFORE the install, and everything in
// between can throw (`calculateHitRegions`, the `groupChange` emit that
// synchronously runs Panel `onResize` and Separator subscribers, the
// "Separator ids must be unique" assert). A throw there means `mountGroup`
// never returns its unmount closure, so nothing ever decrements the count: it
// stays pinned above 0 and the `=== 1` gate never fires again. Every panel in
// the document stops responding to drags until a reload, and because the throw
// surfaces as an error-boundary trip the cause looks unrelated.
//
// We patch the library (patches/react-resizable-panels@4.12.1.patch) to install
// unconditionally. `addEventListener` de-dupes identical (type, listener,
// capture) triples and the handlers are module-level singletons, so repeat
// installs are no-ops — which makes any refcount skew self-healing on the next
// group mount rather than permanent.
//
// Scope note: this drives the leak through the separator-id assert because it
// is the cheapest throw to stage. The other throw sites in that window are not
// exercised individually — they all funnel through the same install, so the
// guard holds for them too, but a refactor that moved the install out from
// under `mountGroup` could regress them while this test stayed green.

afterEach(cleanup);

/** Counts installs/removals of the library's document-level pointerdown handler. */
function trackPointerdownListeners() {
  let installs = 0;
  let removals = 0;
  const originalAdd = document.addEventListener.bind(document);
  const originalRemove = document.removeEventListener.bind(document);
  document.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'pointerdown') installs += 1;
    // @ts-expect-error variadic passthrough to the captured original
    return originalAdd(type, ...rest);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'pointerdown') removals += 1;
    // @ts-expect-error variadic passthrough to the captured original
    return originalRemove(type, ...rest);
  }) as typeof document.removeEventListener;
  return {
    get installs() {
      return installs;
    },
    get removals() {
      return removals;
    },
    restore() {
      document.addEventListener = originalAdd;
      document.removeEventListener = originalRemove;
    },
  };
}

function HealthyGroup() {
  return (
    <Group orientation="horizontal" style={{ width: 900 }}>
      <Panel minSize="10%">editor</Panel>
      <Separator />
      <Panel minSize="10%">doc</Panel>
    </Group>
  );
}

// Duplicate separator ids trip `assert(!separatorIds.has(separator.id))`, which
// upstream runs after the refcount increment and before the handler install.
function GroupThatThrowsDuringMount() {
  return (
    <Group orientation="horizontal" style={{ width: 900 }}>
      <Panel minSize="10%">a</Panel>
      <Separator id="duplicate" />
      <Panel minSize="10%">b</Panel>
      <Separator id="duplicate" />
      <Panel minSize="10%">c</Panel>
    </Group>
  );
}

describe('react-resizable-panels installs its pointer handlers on every group mount', () => {
  test('a healthy group installs the document pointerdown handler, and removes it on unmount', async () => {
    const listeners = trackPointerdownListeners();
    try {
      await act(async () => {
        render(<HealthyGroup />);
      });
      expect(listeners.installs).toBeGreaterThan(0);

      // Teardown still balances: the patch drops the install-side count gate,
      // not the removal-side one, so the last group to unmount must still
      // uninstall what it installed. Asserting the pair pins that the patch
      // didn't turn the handlers into a permanent document-level leak.
      await act(async () => {
        cleanup();
      });
      expect(listeners.removals).toBeGreaterThan(0);
    } finally {
      listeners.restore();
    }
  });

  test('a group whose mount threw does not stop later groups from installing', async () => {
    // Stage the leak: this mount increments the refcount, throws before the
    // install, and never yields an unmount closure to decrement it.
    try {
      await act(async () => {
        render(<GroupThatThrowsDuringMount />);
      });
    } catch {
      // The throw is the point — it reaches the app's error boundary in
      // production. What matters is the state it leaves behind.
    }
    cleanup();

    // A well-formed group mounted afterwards must still get working handlers.
    // Before the patch this installed nothing: the refcount was stuck at 1, so
    // the `=== 1` gate never matched again and every panel in the document was
    // undraggable for the life of the page.
    const listeners = trackPointerdownListeners();
    try {
      await act(async () => {
        render(<HealthyGroup />);
      });
      expect(listeners.installs).toBeGreaterThan(0);
    } finally {
      listeners.restore();
    }
  });
});
