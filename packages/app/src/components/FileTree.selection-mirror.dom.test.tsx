/**
 * RTL behavioral counterpart to the source-grep
 * `FileTree.selection-mirror.test.ts`. Pins the singleton-selection invariant
 * at runtime through the extracted
 * `useSelectionMirror` hook.
 *
 * The full FileTree component requires 8+ contexts plus Pierre shadow DOM,
 * which exceeds the <500ms budget. This test exercises the hook
 * directly with a minimal stub that satisfies the model interface
 * (`getItem`, `getSelectedPaths`) plus the per-item handles the hook calls
 * (`getPath`, `isSelected`, `select`, `deselect`, `isExpanded`, `expand`,
 * `focus`). Production callers always pass real Pierre models — the cast
 * through `unknown` makes that boundary explicit.
 *
 * Exercises `render` + `userEvent` under the jsdom substrate (precedent #43);
 * invocation via `bun run test:dom`.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useSelectionMirror } from './use-selection-mirror';

interface StubItem {
  getPath: () => string;
  isSelected: () => boolean;
  select: () => void;
  deselect: () => void;
  isExpanded: () => boolean;
  expand: () => void;
  focus: () => void;
  isDirectory: () => boolean;
  getFocusCount: () => number;
}

interface StubModel {
  getItem: (path: string) => StubItem | null;
  getSelectedPaths: () => string[];
}

function makeStubModel(paths: string[]): StubModel {
  const items = new Map<string, StubItem>();
  for (const p of paths) {
    let selected = false;
    let focusCount = 0;
    items.set(p, {
      getPath: () => p,
      isSelected: () => selected,
      select: () => {
        selected = true;
      },
      deselect: () => {
        selected = false;
      },
      isExpanded: () => false,
      expand: () => {},
      focus: () => {
        focusCount += 1;
      },
      isDirectory: () => false,
      getFocusCount: () => focusCount,
    });
  }
  return {
    getItem: (path: string) => items.get(path) ?? null,
    getSelectedPaths: () =>
      Array.from(items.entries())
        .filter(([, it]) => it.isSelected())
        .map(([p]) => p),
  };
}

function Harness({ initialPath, model }: { initialPath: string | null; model: StubModel }) {
  const [activeTreePath, setActiveTreePath] = useState<string | null>(initialPath);
  const suppressSelectionRef = useRef(false);

  useSelectionMirror(
    // biome-ignore lint/suspicious/noExplicitAny: Tier-3 stub for the test budget; production callers always pass real Pierre models.
    model as any,
    activeTreePath,
    '',
    suppressSelectionRef,
  );

  return (
    <>
      <button type="button" data-testid="set-A" onClick={() => setActiveTreePath('A.md')}>
        A
      </button>
      <button type="button" data-testid="set-B" onClick={() => setActiveTreePath('B.md')}>
        B
      </button>
      <button type="button" data-testid="set-null" onClick={() => setActiveTreePath(null)}>
        none
      </button>
      <button
        type="button"
        data-testid="set-absent"
        onClick={() => setActiveTreePath('.hidden/absent.md')}
      >
        absent
      </button>
      <span data-testid="selected">{model.getSelectedPaths().join(',')}</span>
    </>
  );
}

describe('FileTree selection-mirror (Tier-3 mount)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  test('initial mount selects the active path', () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('userEvent.click → singleton-mirror invariant on activeTreePath switch', async () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toEqual(['A.md']);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('set-B'));

    expect(model.getSelectedPaths()).toEqual(['B.md']);
  });

  test('clicking the null-button clears all selection', async () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toEqual(['A.md']);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('set-null'));

    expect(model.getSelectedPaths()).toEqual([]);
  });

  test('navigating to a doc with no visible tree row deselects the previous row', async () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toEqual(['A.md']);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('set-absent'));

    expect(model.getSelectedPaths()).toEqual([]);
  });

  test('absent active row still expands visible ancestors while clearing stale selection', () => {
    let parentExpanded = false;
    let parentExpandCallCount = 0;
    let otherSelected = true;
    const items = new Map<string, StubItem>([
      [
        'parent/',
        {
          getPath: () => 'parent/',
          isSelected: () => false,
          select: () => {},
          deselect: () => {},
          isExpanded: () => parentExpanded,
          expand: () => {
            parentExpanded = true;
            parentExpandCallCount += 1;
          },
          focus: () => {},
          isDirectory: () => true,
          getFocusCount: () => 0,
        },
      ],
      [
        'other.md',
        {
          getPath: () => 'other.md',
          isSelected: () => otherSelected,
          select: () => {
            otherSelected = true;
          },
          deselect: () => {
            otherSelected = false;
          },
          isExpanded: () => false,
          expand: () => {},
          focus: () => {},
          isDirectory: () => false,
          getFocusCount: () => 0,
        },
      ],
    ]);
    const model: StubModel = {
      getItem: (path: string) => items.get(path) ?? null,
      getSelectedPaths: () =>
        Array.from(items.entries())
          .filter(([, it]) => it.isSelected())
          .map(([p]) => p),
    };
    function PartiallyHiddenHarness() {
      const suppressSelectionRef = useRef(false);
      useSelectionMirror(
        // biome-ignore lint/suspicious/noExplicitAny: Tier-3 stub for the test budget; production callers always pass real Pierre models.
        model as any,
        'parent/.hidden-child.md',
        'parent/',
        suppressSelectionRef,
      );
      return null;
    }
    render(<PartiallyHiddenHarness />);

    expect(parentExpandCallCount).toBe(1);
    expect(parentExpanded).toBe(true);
    expect(model.getSelectedPaths()).toEqual([]);
  });

  test('non-empty activeAncestorTreePathsSignature expands every collapsed ancestor', () => {
    let parentExpanded = false;
    let parentExpandCallCount = 0;
    const items = new Map<string, StubItem>([
      [
        'parent/',
        {
          getPath: () => 'parent/',
          isSelected: () => false,
          select: () => {},
          deselect: () => {},
          isExpanded: () => parentExpanded,
          expand: () => {
            parentExpanded = true;
            parentExpandCallCount += 1;
          },
          focus: () => {},
          isDirectory: () => true,
          getFocusCount: () => 0,
        },
      ],
      [
        'parent/child.md',
        {
          getPath: () => 'parent/child.md',
          isSelected: () => false,
          select: () => {},
          deselect: () => {},
          isExpanded: () => false,
          expand: () => {},
          focus: () => {},
          isDirectory: () => false,
          getFocusCount: () => 0,
        },
      ],
    ]);
    const model: StubModel = {
      getItem: (path: string) => items.get(path) ?? null,
      getSelectedPaths: () => [],
    };
    function AncestorHarness() {
      const suppressSelectionRef = useRef(false);
      useSelectionMirror(
        // biome-ignore lint/suspicious/noExplicitAny: Tier-3 stub for the test budget; production callers always pass real Pierre models.
        model as any,
        'parent/child.md',
        'parent/',
        suppressSelectionRef,
      );
      return null;
    }
    render(<AncestorHarness />);

    expect(parentExpandCallCount).toBe(1);
    expect(parentExpanded).toBe(true);
  });

  test('preserves deliberate multi-selection when activeTreePath is already among the selected paths', () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    model.getItem('A.md')?.select();
    model.getItem('B.md')?.select();
    model.getItem('C.md')?.select();

    render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toContain('A.md');
    expect(model.getSelectedPaths()).toContain('B.md');
    expect(model.getSelectedPaths()).toContain('C.md');
    expect(model.getItem('A.md')?.getFocusCount()).toBe(1);
  });

  test('singleton-collapse still fires when activeTreePath is absent from a multi-selection (true navigation)', async () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    model.getItem('B.md')?.select();
    model.getItem('C.md')?.select();

    render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('unmount drains the queueMicrotask cleanup without React post-unmount warning', async () => {
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    const { unmount } = render(<Harness initialPath="A.md" model={model} />);

    expect(model.getSelectedPaths()).toEqual(['A.md']);

    unmount();
    await Promise.resolve();
    await Promise.resolve();

    const sawPostUnmountWarning = consoleErrorSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return typeof message === 'string' && /unmount(ed)? component/i.test(message);
    });
    expect(sawPostUnmountWarning).toBe(false);
  });
});
