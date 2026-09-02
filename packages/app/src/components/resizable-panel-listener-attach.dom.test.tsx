import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(cleanup);

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

      await act(async () => {
        cleanup();
      });
      expect(listeners.removals).toBeGreaterThan(0);
    } finally {
      listeners.restore();
    }
  });

  test('a group whose mount threw does not stop later groups from installing', async () => {
    try {
      await act(async () => {
        render(<GroupThatThrowsDuringMount />);
      });
    } catch {}
    cleanup();

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
