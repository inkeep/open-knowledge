import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { emitConfigIgnoreNestedError } from '@/lib/config-ignore-nested-error-events';
import { emitConfigValidationRejected } from '@/lib/config-validation-events';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const toast = {
  error: mock((_message: string, _opts?: unknown) => {}),
};

type DragEndHandler = (event: { active: { id: string }; over: { id: string } | null }) => void;
let latestDragEnd: DragEndHandler | null = null;
const pointerSensorToken = { name: 'PointerSensor' };
const keyboardSensorToken = { name: 'KeyboardSensor' };
const sortableKeyboardCoordinatesToken = { name: 'sortableKeyboardCoordinates' };
const verticalListSortingStrategyToken = { name: 'verticalListSortingStrategy' };
const localStorageMap = new Map<string, string>();

function installLocalStorage() {
  const storage = {
    clear: () => localStorageMap.clear(),
    getItem: (key: string) => localStorageMap.get(key) ?? null,
    key: (index: number) => Array.from(localStorageMap.keys())[index] ?? null,
    removeItem: (key: string) => {
      localStorageMap.delete(key);
    },
    setItem: (key: string, value: string) => {
      localStorageMap.set(key, value);
    },
    get length() {
      return localStorageMap.size;
    },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('sonner', () => ({
  toast,
}));

mock.module('@dnd-kit/core', () => ({
  closestCenter: { name: 'closestCenter' },
  DndContext: ({ children, onDragEnd }: { children?: ReactNode; onDragEnd?: DragEndHandler }) => {
    latestDragEnd = onDragEnd ?? null;
    return <div data-testid="okignore-dnd-context">{children}</div>;
  },
  KeyboardSensor: keyboardSensorToken,
  PointerSensor: pointerSensorToken,
  useSensor: (sensor: unknown, options: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
}));

mock.module('@dnd-kit/sortable', () => ({
  SortableContext: ({
    children,
    items,
    strategy,
  }: {
    children?: ReactNode;
    items: string[];
    strategy: unknown;
  }) => (
    <div
      data-items={items.join('|')}
      data-strategy={strategy === verticalListSortingStrategyToken ? 'vertical' : 'unknown'}
      data-testid="okignore-sortable-context"
    >
      {children}
    </div>
  ),
  sortableKeyboardCoordinates: sortableKeyboardCoordinatesToken,
  useSortable: ({ id }: { id: string }) => ({
    attributes: { 'data-sortable-attr-id': id },
    isDragging: false,
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
  }),
  verticalListSortingStrategy: verticalListSortingStrategyToken,
}));

mock.module('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

mock.module('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    size?: string;
    variant?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

mock.module('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-testid="skeleton" />
  ),
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div role="tooltip">{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({
    assetPaths: new Set(['assets/logo.png']),
    pageMeta: new Map([
      ['docs/guide', { docExt: '.md' }],
      ['drafts/note', { docExt: '.mdx' }],
    ]),
    pages: new Set(['docs/guide', 'drafts/note']),
  }),
}));

function createBinding(initialText: string) {
  let currentText = initialText;
  const textListeners = new Set<(next: string) => void>();
  const rejectionListeners = new Set<(event: { error: unknown }) => void>();
  return {
    current: () => currentText,
    notifyRejection: (error: unknown) => {
      for (const listener of rejectionListeners) listener({ error });
    },
    patch: mock((next: string) => {
      currentText = next;
      for (const listener of textListeners) listener(next);
      return { ok: true };
    }),
    setText(next: string) {
      currentText = next;
      for (const listener of textListeners) listener(next);
    },
    subscribe: (listener: (next: string) => void) => {
      textListeners.add(listener);
      return () => textListeners.delete(listener);
    },
    subscribeRejection: (listener: (event: { error: unknown }) => void) => {
      rejectionListeners.add(listener);
      return () => rejectionListeners.delete(listener);
    },
  };
}

async function renderSection({
  binding = createBinding(''),
  synced = true,
}: {
  binding?: ReturnType<typeof createBinding> | null;
  synced?: boolean;
} = {}) {
  const { OkignoreSection } = await import('./OkignoreSection');
  render(<OkignoreSection binding={binding as never} synced={synced} />);
  return binding;
}

describe('OkignoreSection runtime behavior', () => {
  beforeEach(() => {
    cleanup();
    latestDragEnd = null;
    toast.error.mockClear();
    installLocalStorage();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders skeleton until the binding is available and synced', async () => {
    await renderSection({ binding: null, synced: false });
    expect(screen.getByTestId('settings-okignore-skeleton')).toBeTruthy();
    expect(screen.getByText('Ignore patterns')).toBeTruthy();
  });

  test('empty state uses plain language, primer link semantics, and disabled add until nonblank input', async () => {
    const binding = await renderSection();

    expect(screen.getByTestId('settings-okignore-section').getAttribute('aria-labelledby')).toBe(
      'settings-okignore-title',
    );
    expect(screen.getByText('Ignore patterns')).toBeTruthy();
    expect(screen.getByText(/Hide files and folders/)).toBeTruthy();
    expect(screen.getByTestId('settings-okignore-empty').textContent?.toLowerCase()).not.toContain(
      'gitignore',
    );
    const primer = screen.getByTestId('settings-okignore-primer') as HTMLAnchorElement;
    expect(primer.textContent).toBe('Learn more about patterns');
    expect(primer.target).toBe('_blank');
    expect(primer.rel).toBe('noreferrer noopener');

    const input = screen.getByTestId('settings-okignore-add-input') as HTMLInputElement;
    const button = screen.getByTestId('settings-okignore-add-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  drafts/  ' } });
    expect(button.disabled).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(binding?.patch).toHaveBeenCalledWith('drafts/\n');
  });

  test('list rows edit on blur, remove by button, and skip duplicate add', async () => {
    const binding = await renderSection({ binding: createBinding('drafts/\nassets/*.png\n') });
    await screen.findByTestId('settings-okignore-list');

    const rows = screen.getAllByTestId('settings-okignore-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('okignore-sortable-context').getAttribute('data-strategy')).toBe(
      'vertical',
    );
    expect(
      screen.getAllByTestId('settings-okignore-drag-handle')[0].getAttribute('aria-label'),
    ).toBe('Drag drafts/ to reorder');

    const firstInput = within(rows[0]).getByTestId(
      'settings-okignore-row-input',
    ) as HTMLInputElement;
    fireEvent.focus(firstInput);
    fireEvent.change(firstInput, { target: { value: 'notes/private/' } });
    fireEvent.blur(firstInput);
    await waitFor(() => {
      expect(binding?.patch).toHaveBeenCalledWith('notes/private/\nassets/*.png\n');
    });

    binding?.patch.mockClear();
    const addInput = screen.getByTestId('settings-okignore-add-input') as HTMLInputElement;
    fireEvent.change(addInput, { target: { value: 'assets/*.png' } });
    fireEvent.click(screen.getByTestId('settings-okignore-add-button'));
    expect(binding?.patch).not.toHaveBeenCalled();

    const rowsAfterEdit = screen.getAllByTestId('settings-okignore-row');
    fireEvent.click(within(rowsAfterEdit[1]).getByTestId('settings-okignore-remove'));
    await waitFor(() => {
      expect(binding?.patch).toHaveBeenCalledWith('notes/private/\n');
    });
  });

  test('reorders pattern rows through the drag-end handler', async () => {
    const binding = await renderSection({ binding: createBinding('drafts/\nassets/*.png\n') });
    await screen.findByTestId('settings-okignore-list');

    act(() => {
      latestDragEnd?.({
        active: { id: 'okignore-pattern-0' },
        over: { id: 'okignore-pattern-1' },
      });
    });
    expect(binding?.patch).toHaveBeenCalledWith('assets/*.png\ndrafts/\n');
  });

  test('advanced raw editor persists toggle state and flushes raw text on blur', async () => {
    const binding = await renderSection({ binding: createBinding('# keep comments\ndrafts/\n') });

    fireEvent.click(screen.getByTestId('settings-okignore-show-advanced-toggle'));
    expect(localStorage.getItem('okignore-show-advanced')).toBe('true');

    const textarea = screen.getByTestId(
      'settings-okignore-advanced-textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('# keep comments\ndrafts/\n');
    fireEvent.change(textarea, {
      target: { value: '# keep comments\nprivate/\n!private/keep.md\n' },
    });
    fireEvent.blur(textarea);
    expect(binding?.patch).toHaveBeenCalledWith('# keep comments\nprivate/\n!private/keep.md\n');

    fireEvent.click(screen.getByTestId('settings-okignore-show-advanced-toggle'));
    expect(localStorage.getItem('okignore-show-advanced')).toBe('false');
  });

  test('preview, rejection banner, and nested-error toast are runtime side effects', async () => {
    const binding = await renderSection({ binding: createBinding('docs/**\n') });

    const visiblePreview = screen
      .getAllByTestId('settings-okignore-preview')
      .find((el) => el.getAttribute('data-preview-state') === 'visible');
    expect(visiblePreview?.getAttribute('data-preview-count')).toBe('1');

    act(() => {
      emitConfigValidationRejected({
        docName: '__config__/okignore',
        error: {
          code: 'OKIGNORE_INVALID',
          detail: 'bad glob',
          lineNumber: 3,
        },
      } as never);
    });
    expect(binding?.current()).toBe('docs/**\n');
    expect((await screen.findByTestId('settings-okignore-rejection-banner')).textContent).toBe(
      'Pattern syntax error (line 3): bad glob',
    );

    act(() => {
      emitConfigIgnoreNestedError({ path: 'nested/.okignore', error: 'parse failed' } as never);
    });
    expect(toast.error).toHaveBeenCalledWith('Nested .okignore error in nested/.okignore', {
      description: 'parse failed',
      duration: 8000,
      id: 'okignore-nested-error:nested/.okignore',
    });
  });
});
