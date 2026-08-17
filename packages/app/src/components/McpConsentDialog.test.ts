import { describe, expect, test, vi } from 'vitest';
import type { OkMcpWiringEditorId, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { McpConsentDialog } from './McpConsentDialog';
import {
  computeInitialSelection,
  computeInitialSkillSelection,
  isPathRowActionable,
  partitionEditorsForDisplay,
  selectedIdsOrdered,
  type ToastImpl,
  toggleSelectedId,
} from './McpConsentDialogBody';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];
type GlobalSkill = OkMcpWiringShowPayload['globalSkills'][number];

/** Skill-descriptor factory — fills the disclosure fields the initial-selection
 *  helper doesn't read (name/description/paths/size), so each case stays focused
 *  on id + hosts. */
function gs(o: Pick<GlobalSkill, 'id' | 'hosts'>): GlobalSkill {
  return { name: o.id, alreadyInstalled: false, description: '', paths: [], ...o };
}

/** Detection-literal factory — fills the location-disclosure fields
 *  (configPath/entryLocator) the pure selection/ordering helpers under test
 *  don't read, so each case stays focused on id/detected/willReplace. */
function ed(o: Omit<EditorDetection, 'configPath' | 'entryLocator'>): EditorDetection {
  return { configPath: null, entryLocator: 'mcpServers.open-knowledge', ...o };
}

const sampleDetection: readonly EditorDetection[] = [
  ed({ id: 'claude', label: 'Claude', detected: true, willReplace: false }),
  ed({ id: 'claude-desktop', label: 'Claude Desktop', detected: false, willReplace: false }),
  ed({ id: 'cursor', label: 'Cursor', detected: true, willReplace: false }),
  ed({ id: 'codex', label: 'Codex', detected: false, willReplace: false }),
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
      ed({ id: 'claude', label: 'Claude', detected: true, willReplace: false }),
      ed({ id: 'cursor', label: 'Cursor', detected: true, willReplace: false }),
    ]);
    expect(sel.size).toBe(2);
  });

  test('none-detected preselects none', () => {
    const sel = computeInitialSelection([
      ed({ id: 'claude', label: 'Claude', detected: false, willReplace: false }),
      ed({ id: 'cursor', label: 'Cursor', detected: false, willReplace: false }),
    ]);
    expect(sel.size).toBe(0);
  });
});

describe('computeInitialSkillSelection', () => {
  test('pre-checks bundles with a resolved host; excludes a zero-host bundle', () => {
    const sel = computeInitialSkillSelection([
      gs({ id: 'discovery', hosts: ['claude'] }),
      gs({ id: 'write-skill', hosts: [] }),
    ]);
    expect(sel.has('discovery')).toBe(true);
    expect(sel.has('write-skill')).toBe(false);
    expect(sel.size).toBe(1);
  });

  test('all reach resolved: every bundle pre-checked (opt-out default)', () => {
    const sel = computeInitialSkillSelection([
      gs({ id: 'discovery', hosts: ['claude'] }),
      gs({ id: 'write-skill', hosts: ['cursor'] }),
    ]);
    expect(sel.size).toBe(2);
  });

  test('zero hosts everywhere: nothing pre-checked (never stage an install that cannot land)', () => {
    const sel = computeInitialSkillSelection([
      gs({ id: 'discovery', hosts: [] }),
      gs({ id: 'write-skill', hosts: [] }),
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
      ed({ id: 'codex', label: 'Codex', detected: false, willReplace: false }),
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

describe('partitionEditorsForDisplay', () => {
  const claude = ed({ id: 'claude', label: 'Claude', detected: true, willReplace: false });
  const cursor = ed({ id: 'cursor', label: 'Cursor', detected: true, willReplace: false });
  const codex = ed({ id: 'codex', label: 'Codex', detected: false, willReplace: false });
  const opencode = ed({ id: 'opencode', label: 'OpenCode', detected: false, willReplace: false });

  const none = new Set<OkMcpWiringEditorId>();

  test('collapsed: shows only detected, hides unchecked undetected behind the toggle', () => {
    const r = partitionEditorsForDisplay([claude, codex, cursor, opencode], none, false);
    expect(r.collapsible).toBe(true);
    expect(r.hiddenCount).toBe(2);
    expect(r.visible.map((e) => e.id)).toEqual(['claude', 'cursor']);
  });

  test('expanded: always-shown first, then hideable; hiddenCount labels the toggle', () => {
    const r = partitionEditorsForDisplay([claude, codex, cursor, opencode], none, true);
    expect(r.collapsible).toBe(true);
    expect(r.hiddenCount).toBe(2);
    expect(r.visible.map((e) => e.id)).toEqual(['claude', 'cursor', 'codex', 'opencode']);
  });

  test('consent integrity: a checked undetected tool survives collapse (never hidden)', () => {
    // User expanded, checked codex (undetected), then collapsed. codex must stay
    // visible because it is still in the write set; only unchecked opencode hides.
    const r = partitionEditorsForDisplay(
      [claude, codex, cursor, opencode],
      new Set<OkMcpWiringEditorId>(['codex']),
      false,
    );
    expect(r.collapsible).toBe(true);
    expect(r.hiddenCount).toBe(1);
    expect(r.visible.map((e) => e.id)).toEqual(['claude', 'codex', 'cursor']);
  });

  test('all detected: not collapsible, shows everything', () => {
    const r = partitionEditorsForDisplay([claude, cursor], none, false);
    expect(r.collapsible).toBe(false);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible.map((e) => e.id)).toEqual(['claude', 'cursor']);
  });

  test('every undetected tool checked: nothing hideable, not collapsible', () => {
    const r = partitionEditorsForDisplay(
      [codex, opencode],
      new Set<OkMcpWiringEditorId>(['codex', 'opencode']),
      false,
    );
    expect(r.collapsible).toBe(false);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible.map((e) => e.id)).toEqual(['codex', 'opencode']);
  });

  test('none detected + none checked: empty-state fallback shows all (never a blank list)', () => {
    const r = partitionEditorsForDisplay([codex, opencode], none, false);
    expect(r.collapsible).toBe(false);
    expect(r.hiddenCount).toBe(0);
    expect(r.visible.map((e) => e.id)).toEqual(['codex', 'opencode']);
  });
});

describe('McpConsentDialog module shape', () => {
  test('exports the component + the pure selection/display helpers + ToastImpl type', () => {
    expect(typeof McpConsentDialog).toBe('function');
    expect(typeof computeInitialSelection).toBe('function');
    expect(typeof toggleSelectedId).toBe('function');
    expect(typeof selectedIdsOrdered).toBe('function');
    expect(typeof partitionEditorsForDisplay).toBe('function');
    // ToastImpl is a type; no runtime export — this assertion just ensures
    // the import resolves at type-check time. The shape is exercised by the
    // toast injection contract below.
    const toastShape: ToastImpl = { error: () => {}, message: () => {} };
    expect(typeof toastShape.error).toBe('function');
    expect(typeof toastShape.message).toBe('function');
  });

  test('ToastImpl exposes the full error + message surface the dialog injects', () => {
    // Records the surface the dialog injects: any object with `error` +
    // `message` substitutes for the production `defaultToast` (which wraps
    // `sonnerToast.error` / `sonnerToast.message`). NOTE: this only DOCUMENTS
    // the shape — it cannot fail on a shape change. `**/*.test.ts` is excluded
    // from `packages/app/tsconfig.json` and vitest runs without `--typecheck`,
    // so these literals are never type-checked; a real compile-time guard would
    // need a test-inclusive tsconfig or `test.typecheck`, a packages/app-wide
    // call out of scope here.
    const errors: string[] = [];
    const messages: string[] = [];
    const toast: ToastImpl = {
      error: (msg) => errors.push(msg),
      message: (msg) => messages.push(msg),
    };
    toast.error('boom');
    toast.message('fyi');
    expect(errors).toEqual(['boom']);
    expect(messages).toEqual(['fyi']);
  });

  test('mock module-level usage check: toast methods are invocable from a Set-like context', () => {
    // Smoke that the ToastImpl shape composes through `mock()` for callers
    // that want to inject spies.
    const spy = vi.fn((_msg: string) => {});
    const toast: ToastImpl = { error: spy, message: vi.fn() };
    toast.error('hello');
    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0]).toEqual(['hello']);
  });
});
