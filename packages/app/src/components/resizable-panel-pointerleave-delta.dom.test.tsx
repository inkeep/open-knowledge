import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

// Regression guard for a right-docked panel that collapses to zero the instant
// the pointer leaves the window mid-drag.
//
// react-resizable-panels listens for `pointerleave` on the owner document and,
// while a drag is active, routes it into the same delta calculator the move
// handler uses. Every other caller forwards the drag origin; the leave handler
// alone omits it, and the calculator's no-origin fallback is not a small delta
// but `clientX < 0 ? -100 : 100` — the entire group's width in a single event.
// A `collapsible` panel reads that as crossing its collapse threshold and snaps
// to `collapsedSize`, so one stray leave shuts the column. Chromium 150 (the
// Electron 43 upgrade) started emitting that leave on Linux during the boundary
// cascade around `setPointerCapture`, which is what made a latent misreading
// visible there first.
//
// We patch the library (patches/react-resizable-panels@4.12.1.patch) so the
// leave handler forwards `pointerDownAtPoint`, making the whole-group fallback
// unreachable while a drag is active. `state: "active"` is set synchronously in
// the `pointerdown` handler, in the same call that records the origin, so there
// is no active-state path that lacks one.
//
// Scope note: this drives the CJS image (Vitest resolves it) with a synthetic
// event pair. The platform-level counterpart — a real Electron drag whose leave
// is emitted by the browser rather than dispatched by hand — is
// `packages/desktop/tests/smoke/terminal-dock.e2e.ts`, which exercises the ESM
// image through Vite. Both images carry the hunk and each test sees only one of
// them, so keep the pair: dropping either leaves that image unpinned on the
// next re-derivation.

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

// Two panels at this width put the group at PANEL_WIDTH * 2, so a pointer
// travelling TRAVEL_PX is exactly TRAVEL_PCT of the group.
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
      {/* Mirrors the app's right dock: collapsible with a zero collapsed size,
          which is what makes a whole-group delta land on 0 rather than clamp. */}
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

/**
 * jsdom does not implement PointerEvent in any runtime this suite runs under.
 * The library's listeners key off the event `type` string rather than the event
 * class, so a MouseEvent dispatched under a pointer-event type name reaches
 * them. The fields they read are MouseEvent-shaped (`clientX`/`clientY` for the
 * delta, `movementX`/`movementY` for the cursor flags, `button` on pointerdown)
 * with one exception: pointerdown also gates on `pointerType === 'mouse' &&
 * button > 0` to bail out of real right-clicks. A plain MouseEvent's
 * `pointerType` is always undefined, so that gate cannot fire here, which is
 * fine because this test only ever drives the left button.
 */
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

      // jsdom reports every rect as zero-at-origin, so the origin is the only
      // point inside the separator's hit region. That is fine for this test:
      // what matters is the distance between the down point and the leave
      // point, not where either sits on a real screen.
      await act(async () => {
        separator.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 }));
      });

      // The pointer leaves the window TRAVEL_PX to the right of where it went
      // down. Correct behavior moves the separator right by that much, shrinking
      // the right panel from 40% to 30%. Under the unpatched fallback the delta
      // is +100% and the right panel collapses to 0.
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

      // Stated first and separately: the collapse is the reported bug, and this
      // is the assertion whose failure names it.
      expect(right).toBeGreaterThan(0);

      // Then the stronger claim the fix actually makes — the resize equals the
      // distance travelled. This is what separates forwarding the origin from
      // merely ignoring the event, which would leave the panel untouched at 40%.
      expect(right).toBeCloseTo(RIGHT_DEFAULT_PCT - TRAVEL_PCT, 1);
    });
  });
});
