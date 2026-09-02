import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

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
    const liveRegions = document.body.querySelectorAll('[id^="DndLiveRegion"]');
    const describedBys = document.body.querySelectorAll('[id^="DndDescribedBy"]');
    expect(liveRegions.length).toBeGreaterThan(0);
    expect(describedBys.length).toBeGreaterThan(0);
  });

  test('WITHOUT portal (control): SR helpers land inside the strip — pinning the regression we fixed', () => {
    const { getByTestId } = render(<StripFixture items={['a']} withPortal={false} />);
    const strip = getByTestId('strip');
    const liveRegionInStrip = strip.querySelector('[id^="DndLiveRegion"]');
    const describedByInStrip = strip.querySelector('[id^="DndDescribedBy"]');
    expect(liveRegionInStrip).not.toBeNull();
    expect(describedByInStrip).not.toBeNull();
    const plus = getByTestId('plus-button');
    expect(strip.firstElementChild).not.toBe(plus);
  });
});
