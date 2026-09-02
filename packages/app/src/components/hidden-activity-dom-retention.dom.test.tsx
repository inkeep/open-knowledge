// @vitest-environment jsdom
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
    expect(after).toBe(before);
    expect(unmounts).toBe(1);
    expect(mounts).toBe(1);

    rerender(
      <Activity mode="visible">
        <EffectProbe onMount={onMount} onUnmount={onUnmount} />
      </Activity>,
    );
    expect(container.querySelector('[data-testid="activity-probe"]')).toBe(before);
    expect(mounts).toBe(2);
    expect(unmounts).toBe(1);
  });
});
