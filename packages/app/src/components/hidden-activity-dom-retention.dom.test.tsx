// @vitest-environment jsdom
/**
 * Observes the React 19 `<Activity mode="hidden">` behavior the pool's scroll
 * bookkeeping and the subtree AGENTS.md WARN rule depend on: hiding a subtree
 * does NOT unmount its DOM — the same element survives the flip (state/refs kept)
 * while only its effects unmount. This is what makes more than one
 * editor-scroll-container coexist at once (hence the painted-container filter in
 * `visibleEditorScrollContainer`) and what lets a pooled doc's ref-stored scroll
 * position survive a mode flip. If a React upgrade ever made hidden Activity
 * unmount the DOM, the same-node assertion fails and the rule needs revisiting.
 */
import { cleanup, render } from '@testing-library/react';
import { Activity, useEffect } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

function EffectProbe({ onMount, onUnmount }: { onMount: () => void; onUnmount: () => void }) {
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return <div data-testid="activity-probe">probe</div>;
}

afterEach(cleanup);

describe('React <Activity mode="hidden"> retains DOM while unmounting effects', () => {
  test('flipping visible to hidden keeps the same DOM node and runs the effect cleanup', () => {
    let mounts = 0;
    let unmounts = 0;
    const onMount = () => {
      mounts += 1;
    };
    const onUnmount = () => {
      unmounts += 1;
    };

    const { container, rerender } = render(
      <Activity mode="visible">
        <EffectProbe onMount={onMount} onUnmount={onUnmount} />
      </Activity>,
    );
    const before = container.querySelector('[data-testid="activity-probe"]');
    expect(before).not.toBeNull();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);

    rerender(
      <Activity mode="hidden">
        <EffectProbe onMount={onMount} onUnmount={onUnmount} />
      </Activity>,
    );

    const after = container.querySelector('[data-testid="activity-probe"]');
    // The DOM is not unmounted: the exact same node survives the flip to hidden.
    expect(after).toBe(before);
    // ...but its effects do unmount — the cleanup ran once, with no re-mount.
    expect(unmounts).toBe(1);
    expect(mounts).toBe(1);

    rerender(
      <Activity mode="visible">
        <EffectProbe onMount={onMount} onUnmount={onUnmount} />
      </Activity>,
    );
    // Revealing re-mounts the effects on the still-present node (state preserved).
    expect(container.querySelector('[data-testid="activity-probe"]')).toBe(before);
    expect(mounts).toBe(2);
    expect(unmounts).toBe(1);
  });
});
