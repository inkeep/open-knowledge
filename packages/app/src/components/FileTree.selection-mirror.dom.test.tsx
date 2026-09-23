/** Exercises `render` + `userEvent` under the jsdom substrate (precedent #43). */

import { FileTree } from '@pierre/trees';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { revealActiveRow } from './file-tree-reveal';
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

type ExpansionOnlyModel = Pick<StubModel, 'getItem' | 'getSelectedPaths' | 'getFocusedPath'>;

interface StubModel {
  getItem: (path: string) => StubItem | null;
  getSelectedPaths: () => string[];
  getFocusedPath: () => string | null;
  addPath: (path: string) => void;
}

function makeStubModel(paths: string[]): StubModel {
  const items = new Map<string, StubItem>();
  let focusedPath: string | null = null;
  const addPath = (p: string) => {
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
        focusedPath = p;
      },
      isDirectory: () => false,
      getFocusCount: () => focusCount,
    });
  };
  for (const p of paths) {
    addPath(p);
  }
  return {
    getItem: (path: string) => items.get(path) ?? null,
    getSelectedPaths: () =>
      Array.from(items.entries())
        .filter(([, it]) => it.isSelected())
        .map(([p]) => p),
    getFocusedPath: () => focusedPath,
    addPath,
  };
}

interface HarnessModel {
  getItem: (path: string) => unknown;
  getSelectedPaths: () => readonly string[];
  getFocusedPath: () => string | null;
}

function Harness({ initialPath, model }: { initialPath: string | null; model: HarnessModel }) {
  const [activeTreePath, setActiveTreePath] = useState<string | null>(initialPath);
  const [treePathsSignature, setTreePathsSignature] = useState('initial');
  const suppressSelectionRef = useRef(false);

  useSelectionMirror(
    // biome-ignore lint/suspicious/noExplicitAny: Tier-3 stub for the test budget; production callers always pass real Pierre models.
    model as any,
    activeTreePath,
    '',
    suppressSelectionRef,
    treePathsSignature,
  );

  return (
    <>
      <button
        type="button"
        data-testid="repopulate"
        onClick={() => setTreePathsSignature((previous) => `${previous}+`)}
      >
        repopulate
      </button>
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
    const model: ExpansionOnlyModel = {
      getItem: (path: string) => items.get(path) ?? null,
      getSelectedPaths: () =>
        Array.from(items.entries())
          .filter(([, it]) => it.isSelected())
          .map(([p]) => p),
      getFocusedPath: () => null,
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
    const model: ExpansionOnlyModel = {
      getItem: (path: string) => items.get(path) ?? null,
      getSelectedPaths: () => [],
      getFocusedPath: () => null,
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

  test('a repopulation re-run leaves keyboard focus on the row the user focused', async () => {
    const user = userEvent.setup();
    const model = makeStubModel(['A.md', 'B.md', 'folder/']);
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('folder/')?.focus();
    expect(model.getFocusedPath()).toBe('folder/');
    const activeFocusCountBefore = model.getItem('A.md')?.getFocusCount();

    await user.click(screen.getByTestId('repopulate'));

    expect(model.getFocusedPath()).toBe('folder/');
    expect(model.getItem('A.md')?.getFocusCount()).toBe(activeFocusCountBefore);
    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('a true activation still claims focus even while another row holds it', async () => {
    const user = userEvent.setup();
    const model = makeStubModel(['A.md', 'B.md', 'folder/']);
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('folder/')?.focus();
    expect(model.getFocusedPath()).toBe('folder/');

    await user.click(screen.getByTestId('set-B'));

    expect(model.getFocusedPath()).toBe('B.md');
  });

  test('a real drop of the focused row leaves focus where @pierre/trees resolves it', async () => {
    const user = userEvent.setup();
    const model = new FileTree({ paths: ['A.md', 'afolder/x.md', 'zfolder/sibling.md'] });
    model.getItem('zfolder/')?.expand();
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('zfolder/sibling.md')?.focus();
    expect(model.getFocusedPath()).toBe('zfolder/sibling.md');

    model.resetPaths(['A.md', 'afolder/x.md']);
    const fallback = model.getFocusedPath();
    expect(fallback).not.toBeNull();
    expect(fallback).not.toBe('A.md');

    await user.click(screen.getByTestId('repopulate'));

    expect(model.getFocusedPath()).toBe(fallback);
    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('an activation whose row appears only on a later repopulation claims keyboard focus', async () => {
    const user = userEvent.setup();
    const model = makeStubModel(['folder/', 'B.md']);
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('folder/')?.focus();
    expect(model.getFocusedPath()).toBe('folder/');
    expect(model.getSelectedPaths()).toEqual([]);

    model.addPath('A.md');
    await user.click(screen.getByTestId('repopulate'));

    expect(model.getFocusedPath()).toBe('A.md');
    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('re-activating a document after the active path was cleared claims keyboard focus', async () => {
    const user = userEvent.setup();
    const model = makeStubModel(['folder/', 'A.md', 'B.md']);
    render(<Harness initialPath="A.md" model={model} />);

    await user.click(screen.getByTestId('set-null'));
    expect(model.getSelectedPaths()).toEqual([]);

    model.getItem('folder/')?.focus();
    expect(model.getFocusedPath()).toBe('folder/');

    await user.click(screen.getByTestId('set-A'));

    expect(model.getFocusedPath()).toBe('A.md');
    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('a real drop of a nested focused row leaves focus on the surviving folder, not the first row', async () => {
    const user = userEvent.setup();
    const model = new FileTree({
      paths: ['A.md', 'afolder/x.md', 'zfolder/nested.md', 'zfolder/sibling.md'],
    });
    model.getItem('afolder/')?.expand();
    model.getItem('zfolder/')?.expand();
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('zfolder/nested.md')?.focus();
    expect(model.getFocusedPath()).toBe('zfolder/nested.md');

    model.resetPaths(['A.md', 'afolder/x.md', 'zfolder/sibling.md']);
    const fallback = model.getFocusedPath();
    expect(fallback).toBe('zfolder/');

    await user.click(screen.getByTestId('repopulate'));

    expect(model.getFocusedPath()).toBe(fallback);
    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('returning to a document after one with no tree row claims keyboard focus', async () => {
    const user = userEvent.setup();
    const model = makeStubModel(['A.md', 'B.md', 'folder/']);
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('folder/')?.focus();
    expect(model.getFocusedPath()).toBe('folder/');

    await user.click(screen.getByTestId('set-absent'));
    await user.click(screen.getByTestId('set-A'));

    expect(model.getFocusedPath()).toBe('A.md');
    expect(model.getSelectedPaths()).toEqual(['A.md']);
  });

  test('a suppressed claim also withholds the active row reveal, and an activation restores it', async () => {
    const user = userEvent.setup();
    const model = makeStubModel(['A.md', 'B.md', 'folder/']);
    render(<Harness initialPath="A.md" model={model} />);

    model.getItem('folder/')?.focus();
    await user.click(screen.getByTestId('repopulate'));

    const scrollAfterRepopulation = vi.fn();
    revealActiveRow(
      { getFocusedPath: () => model.getFocusedPath(), scrollToPath: scrollAfterRepopulation },
      'A.md',
    );
    expect(scrollAfterRepopulation).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('set-B'));

    const scrollAfterActivation = vi.fn();
    revealActiveRow(
      { getFocusedPath: () => model.getFocusedPath(), scrollToPath: scrollAfterActivation },
      'B.md',
    );
    expect(scrollAfterActivation).toHaveBeenCalledTimes(1);
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
