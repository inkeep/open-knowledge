/**
 * DOM test for the `+` (new-tab) alignment fix.
 *
 * Mounting the full EditorTabs requires the whole document/config/page-list
 * context stack, which exceeds the test budget. This test instead mounts
 * the exact DndContext + sibling-flex pattern EditorTabs uses (DndContext
 * with `accessibility.container = document.body`, a SortableContext child,
 * and the `+` Button as a sibling AFTER `</DndContext>`) and asserts the
 * outcome the alignment bug depends on: the `+` button ends up as the
 * parent flex container's `:first-child` whenever the sortable list is
 * empty, so its `first:mb-3` Tailwind variant resolves correctly.
 *
 * Without the portal, `@dnd-kit` injects `DndLiveRegion` and
 * `DndDescribedBy` divs as children of the DndContext — they land as
 * siblings of the `+` Button in the parent flex flow and occupy the
 * `:first-child` slot, leaving `+` 6px below where the icon-row sits
 * (cy=37 instead of cy=32 in a 48px header).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { cleanup, render } from '@testing-library/react';

function StripFixture({ items, withPortal }: { items: string[]; withPortal: boolean }) {
  return (
    <div data-testid="strip" className="flex items-end gap-1">
      <DndContext
        accessibility={
          withPortal
            ? { container: typeof document !== 'undefined' ? document.body : undefined }
            : undefined
        }
      >
        <SortableContext items={items}>
          {items.map((id) => (
            <div key={id} data-testid={`tab-${id}`}>
              tab {id}
            </div>
          ))}
        </SortableContext>
      </DndContext>
      <button type="button" data-testid="plus-button">
        +
      </button>
    </div>
  );
}

describe('DndContext accessibility portal — `+` button :first-child alignment', () => {
  afterEach(() => {
    cleanup();
  });

  test("WITH portal + empty tabs: `+` button is the parent strip's first child", () => {
    const { getByTestId } = render(<StripFixture items={[]} withPortal />);
    const strip = getByTestId('strip');
    const plus = getByTestId('plus-button');
    expect(strip.firstElementChild).toBe(plus);
  });

  test('WITH portal: DndLiveRegion + DndDescribedBy are NOT siblings inside the strip', () => {
    const { getByTestId } = render(<StripFixture items={['a', 'b']} withPortal />);
    const strip = getByTestId('strip');
    const liveRegionInStrip = strip.querySelector('[id^="DndLiveRegion"]');
    const describedByInStrip = strip.querySelector('[id^="DndDescribedBy"]');
    expect(liveRegionInStrip).toBeNull();
    expect(describedByInStrip).toBeNull();
  });

  test('WITH portal: DndLiveRegion + DndDescribedBy ARE rendered inside document.body', () => {
    render(<StripFixture items={['a']} withPortal />);
    // Note: at least one of each (DndLiveRegion + DndDescribedBy) must
    // exist in the body somewhere — the SR contract requires them.
    const liveRegions = document.body.querySelectorAll('[id^="DndLiveRegion"]');
    const describedBys = document.body.querySelectorAll('[id^="DndDescribedBy"]');
    expect(liveRegions.length).toBeGreaterThan(0);
    expect(describedBys.length).toBeGreaterThan(0);
  });

  test('WITHOUT portal (control): SR helpers land inside the strip — pinning the regression we fixed', () => {
    const { getByTestId } = render(<StripFixture items={['a']} withPortal={false} />);
    const strip = getByTestId('strip');
    // Both helpers appear as DndContext children — siblings of `+` Button.
    const liveRegionInStrip = strip.querySelector('[id^="DndLiveRegion"]');
    const describedByInStrip = strip.querySelector('[id^="DndDescribedBy"]');
    expect(liveRegionInStrip).not.toBeNull();
    expect(describedByInStrip).not.toBeNull();
    // And the `+` button is NO LONGER the parent flex container's first
    // child — the SR helpers occupy that slot. This is exactly what breaks
    // the `first:mb-3` variant.
    const plus = getByTestId('plus-button');
    expect(strip.firstElementChild).not.toBe(plus);
  });
});
