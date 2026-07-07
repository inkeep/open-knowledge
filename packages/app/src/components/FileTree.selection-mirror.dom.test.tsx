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
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
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
      <span data-testid="selected">{model.getSelectedPaths().join(',')}</span>
    </>
  );
}

describe('FileTree selection-mirror (Tier-3 mount)', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
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

  test('non-empty activeAncestorTreePathsSignature expands every collapsed ancestor', () => {
    // Builds a stub model whose `parent/` ancestor reports expanded=false +
    // a working expand() — without this test the ancestor-expansion loop
    // (use-selection-mirror.ts) is never exercised because every other
    // test passes an empty signature.
    let parentExpanded = false;
    let parentExpandCallCount = 0;
    // Ancestor items must return isDirectory()===true to satisfy
    // asDirectoryHandle()'s contract (use-selection-mirror.ts) — for any
    // item returning false the cast returns null and the expansion loop
    // short-circuits.
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
    // Regression guard for the cmd+A race: when a multi-select gesture populates
    // Pierre's selection directly and React commits the new activeTreePath
    // AFTER the multi-select burst, the singleton-collapse must NOT fire.
    // The mirror's invariant is "active row IS selected," not "active row is
    // SOLE selected." Removing the multi-selection guard in use-selection-mirror.ts
    // causes the next two assertions to fail (B.md and C.md would be deselected).
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    // Pre-populate a multi-selection (simulates cmd+A having already fired).
    model.getItem('A.md')?.select();
    model.getItem('B.md')?.select();
    model.getItem('C.md')?.select();

    render(<Harness initialPath="A.md" model={model} />);

    // The mirror saw `currentSelection.length > 1` and `isSelected('A.md')`,
    // taking the early-return and leaving the multi-selection intact.
    expect(model.getSelectedPaths()).toContain('A.md');
    expect(model.getSelectedPaths()).toContain('B.md');
    expect(model.getSelectedPaths()).toContain('C.md');
    // The guard-path branch must still call item.focus() so arrow-key
    // navigation works after a multi-select gesture. Pinning this independently
    // from the singleton-collapse path (which also calls focus()) catches a
    // regression where focus() is removed from only the guard branch.
    expect(model.getItem('A.md')?.getFocusCount()).toBe(1);
  });

  test('singleton-collapse still fires when activeTreePath is absent from a multi-selection (true navigation)', async () => {
    // Companion to the multi-selection-preserved test above: when navigation
    // changes activeTreePath to a row NOT in the existing multi-selection,
    // the singleton invariant should still apply (deselect others, select
    // the new active). Otherwise navigation between tabs while a stale
    // multi-selection exists would visually accumulate.
    const model = makeStubModel(['A.md', 'B.md', 'C.md']);
    // Pre-populate a multi-selection that does NOT include the initial activeTreePath.
    model.getItem('B.md')?.select();
    model.getItem('C.md')?.select();

    render(<Harness initialPath="A.md" model={model} />);

    // Mirror sees `currentSelection.length > 1` but `!isSelected('A.md')`, so it
    // falls through to selectOnlyTreeItem — deselecting B and C, selecting A.
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
