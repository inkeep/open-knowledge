import { describe, expect, mock, test } from 'bun:test';
import type { OkMcpWiringEditorId, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { McpConsentDialog } from './McpConsentDialog';
import {
  computeInitialSelection,
  isPathRowActionable,
  selectedIdsOrdered,
  type ToastImpl,
  toggleSelectedId,
} from './McpConsentDialogBody';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];

const sampleDetection: readonly EditorDetection[] = [
  { id: 'claude', label: 'Claude', detected: true, willReplace: false },
  { id: 'claude-desktop', label: 'Claude Desktop', detected: false, willReplace: false },
  { id: 'cursor', label: 'Cursor', detected: true, willReplace: false },
  { id: 'codex', label: 'Codex', detected: false, willReplace: false },
];

describe('computeInitialSelection', () => {
  test('preselects every detected editor; skips undetected ones (OQ-14)', () => {
    const sel = computeInitialSelection(sampleDetection);
    expect(sel.has('claude')).toBe(true);
    expect(sel.has('cursor')).toBe(true);
    expect(sel.has('claude-desktop')).toBe(false);
    expect(sel.has('codex')).toBe(false);
    expect(sel.size).toBe(2);
  });

  test('empty payload yields empty selection', () => {
    const sel = computeInitialSelection([]);
    expect(sel.size).toBe(0);
  });

  test('all-detected preselects all', () => {
    const sel = computeInitialSelection([
      { id: 'claude', label: 'Claude', detected: true, willReplace: false },
      { id: 'cursor', label: 'Cursor', detected: true, willReplace: false },
    ]);
    expect(sel.size).toBe(2);
  });

  test('none-detected preselects none', () => {
    const sel = computeInitialSelection([
      { id: 'claude', label: 'Claude', detected: false, willReplace: false },
      { id: 'cursor', label: 'Cursor', detected: false, willReplace: false },
    ]);
    expect(sel.size).toBe(0);
  });
});

describe('toggleSelectedId', () => {
  test('adds id when absent', () => {
    const next = toggleSelectedId(new Set<OkMcpWiringEditorId>(), 'claude');
    expect(next.has('claude')).toBe(true);
    expect(next.size).toBe(1);
  });

  test('removes id when present', () => {
    const prev = new Set<OkMcpWiringEditorId>(['claude']);
    const next = toggleSelectedId(prev, 'claude');
    expect(next.has('claude')).toBe(false);
    expect(next.size).toBe(0);
  });

  test('returns a new Set (does not mutate input — immutable-style)', () => {
    const prev = new Set<OkMcpWiringEditorId>(['claude']);
    const next = toggleSelectedId(prev, 'cursor');
    expect(prev.has('cursor')).toBe(false);
    expect(next.has('cursor')).toBe(true);
    expect(prev).not.toBe(next);
  });
});

describe('selectedIdsOrdered', () => {
  test('projects selection back into array preserving detection order', () => {
    const sel = new Set<OkMcpWiringEditorId>(['cursor', 'claude']);
    const out = selectedIdsOrdered(sel, sampleDetection);
    // Detection order is [claude, claude-desktop, cursor, codex].
    // Projection keeps that order, dropping unselected entries.
    expect(out).toEqual(['claude', 'cursor']);
  });

  test('empty selection yields empty array', () => {
    const out = selectedIdsOrdered(new Set<OkMcpWiringEditorId>(), sampleDetection);
    expect(out).toEqual([]);
  });

  test('selected ids NOT in detection payload are dropped (defensive)', () => {
    const sel = new Set<OkMcpWiringEditorId>(['claude']);
    const truncated: readonly EditorDetection[] = [
      { id: 'codex', label: 'Codex', detected: false, willReplace: false },
    ];
    const out = selectedIdsOrdered(sel, truncated);
    expect(out).toEqual([]);
  });

  test('all-selected yields full detection order', () => {
    const allIds = sampleDetection.map((d) => d.id);
    const sel = new Set<OkMcpWiringEditorId>(allIds);
    const out = selectedIdsOrdered(sel, sampleDetection);
    expect(out).toEqual(allIds);
  });
});

describe('isPathRowActionable', () => {
  test('actionable only when an rc file is touchable AND nothing is installed yet', () => {
    expect(
      isPathRowActionable({
        shellDetected: true,
        rcFilesToTouch: ['~/.zshrc'],
        alreadyInstalled: false,
      }),
    ).toBe(true);
  });

  test('hidden row (no touchable rc files) solicits no decision', () => {
    expect(
      isPathRowActionable({ shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false }),
    ).toBe(false);
  });

  test('informational row (already installed / consent granted) solicits no decision', () => {
    expect(
      isPathRowActionable({
        shellDetected: true,
        rcFilesToTouch: ['~/.zshrc'],
        alreadyInstalled: true,
      }),
    ).toBe(false);
  });
});

describe('McpConsentDialog module shape', () => {
  test('exports the component + the three pure helpers + ToastImpl type', () => {
    expect(typeof McpConsentDialog).toBe('function');
    expect(typeof computeInitialSelection).toBe('function');
    expect(typeof toggleSelectedId).toBe('function');
    expect(typeof selectedIdsOrdered).toBe('function');
    // ToastImpl is a type; no runtime export — this assertion just ensures
    // the import resolves at type-check time. The shape is exercised by the
    // toast injection contract below.
    const toastShape: ToastImpl = { error: () => {} };
    expect(typeof toastShape.error).toBe('function');
  });

  test('Pass 0 Critical #1: ToastImpl interface accepts a sonner-shaped error fn', () => {
    // The dialog's `toast` prop is typed `ToastImpl` so the production
    // `defaultToast` (which wraps `sonnerToast.error`) can be substituted in
    // tests by any object with `error(msg: string): void`. This contract test
    // pins the surface so a future refactor that adds methods (warning,
    // success) signals the change explicitly.
    const recorded: string[] = [];
    const toast: ToastImpl = {
      error: (msg) => {
        recorded.push(msg);
      },
    };
    toast.error('test message');
    expect(recorded).toEqual(['test message']);
  });

  test('mock module-level usage check: toast.error is invocable from a Set-like context', () => {
    // Smoke that the ToastImpl shape composes through `mock()` for callers
    // that want to inject a spy.
    const spy = mock((_msg: string) => {});
    const toast: ToastImpl = { error: spy };
    toast.error('hello');
    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0]).toEqual(['hello']);
  });
});
