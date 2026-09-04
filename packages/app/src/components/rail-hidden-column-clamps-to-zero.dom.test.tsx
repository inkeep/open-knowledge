import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, describe, expect, test } from 'vitest';

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

      const initial = group.getLayout();
      expect(initial['hidden-rail']).toBeCloseTo(0, 1);
      expect(initial.editor).toBeCloseTo(100, 1);

      await act(async () => {
        group.setLayout({ editor: 73, 'hidden-rail': 27 });
      });

      const recovered = group.getLayout();

      expect(recovered['hidden-rail']).toBeCloseTo(0, 1);
      expect(recovered.editor).toBeCloseTo(100, 1);

      const hiddenPanel = document.querySelector<HTMLElement>('[data-panel][id="hidden-rail"]');
      if (!hiddenPanel) throw new Error('hidden panel outer div was not rendered');
      const flexGrow = hiddenPanel.style.flexGrow;
      expect(flexGrow === '' || Number(flexGrow) === 0).toBe(true);
    });
  });

  test('present arm: lifting maxSize lets the same panel accept a non-zero share', async () => {
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

      await act(async () => {
        group.setLayout({ editor: 73, 'toggle-rail': 27 });
      });
      expect(group.getLayout()['toggle-rail']).toBeCloseTo(0, 1);

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
      expect(recovered['hidden-rail']).toBeGreaterThan(0);
    });
  });
});
