import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

type UndoClass =
  | 'agent-session-um'
  | 'agent-undo-system'
  | 'client-editor-um'
  | 'system-not-undoable'
  | 'no-undo-manager'
  | 'replay-not-undoable';

interface UndoRow {
  undo: UndoClass;
  why: string;
  contract: string;
}

const ORIGIN_UNDO_CONTRACT: Record<string, UndoRow> = {
  AGENT_WRITE_ORIGIN: {
    undo: 'agent-session-um',
    why: 'Typed exemplar for the agent-write origin; real writes carry the per-session session.origin. Undoable only by the server per-session UndoManager, never by a human Cmd+Z.',
    contract: 'session-undo-manager.test.ts, agent-undo.test.ts',
  },
  FILE_WATCHER_ORIGIN: {
    undo: 'system-not-undoable',
    why: 'Disk-to-CRDT intake (paired). A system origin tracked by no UndoManager.',
    contract: 'external-change disk intake (system origin)',
  },
  ROLLBACK_ORIGIN: {
    undo: 'system-not-undoable',
    why: 'Timeline restore rewrites body + fragment as a paired write; deliberately not client-undoable, and it stales pre-rollback client undo items.',
    contract: 'undo-after-rollback.test.ts',
  },
  MANAGED_RENAME_ORIGIN: {
    undo: 'system-not-undoable',
    why: 'Managed-rename spine (paired). System origin tracked by no UndoManager.',
    contract: 'attribution-sweep-coverage.test.ts (identity threading)',
  },
  GENERATED_ARTIFACT_ORIGIN: {
    undo: 'system-not-undoable',
    why: 'Machine-maintained generated documents are reconciled through a paired system write and are tracked by no UndoManager.',
    contract: 'generated-artifact.test.ts, server-factory.test.ts (generated index wiring)',
  },
  MERMAID_SOURCE_ORIGIN: {
    undo: 'system-not-undoable',
    why: 'Mermaid diagram seed/reconcile into Y.Text(source); system origin, markdown bridge gated off.',
    contract: 'mermaid-persistence (system origin)',
  },
  MERMAID_DIAGRAM_EDIT_ORIGIN: {
    undo: 'client-editor-um',
    why: 'Diagram-label commits, tracked by the MermaidDocEditor own client Y.UndoManager so Cmd+Z reverts a label edit.',
    contract: 'MermaidDocEditor (own UndoManager)',
  },
  FORM_WRITE_ORIGIN: {
    undo: 'no-undo-manager',
    why: 'Frontmatter property-panel write to the YAML region of Y.Text; single-root, captured by no editor UndoManager.',
    contract: 'write-surface-undo-exclusion.test.ts',
  },
  LINT_FIX_ORIGIN: {
    undo: 'no-undo-manager',
    why: 'Client markdownlint auto-fix writing Y.Text(source) directly; captured by no editor UndoManager.',
    contract: 'write-surface-undo-exclusion.test.ts',
  },
  SOURCE_PASTE_ORIGIN: {
    undo: 'no-undo-manager',
    why: 'Chunked large source-mode paste writing Y.Text(source) directly, bypassing CM6 dispatch; captured by no editor UndoManager.',
    contract: 'write-surface-undo-exclusion.test.ts',
  },
  TAB_REPLAY_ORIGIN: {
    undo: 'replay-not-undoable',
    why: 'Recovery replay of buffered updates onto a recycled provider. The replayed bytes are durable but not Cmd+Z-undoable — post-recycle, the last pre-hiccup edits are recovery machinery, not a fresh user action.',
    contract: 'undo-recycle-reset.test.ts',
  },
};

const FACTORY_ORIGIN_ROWS: Record<string, UndoRow> = {
  createSessionOrigin: {
    undo: 'agent-session-um',
    why: 'Mints the per-session frozen agent-write origin (session.origin); object-identity-unique, added to the session UndoManager trackedOrigins so only that session can undo its writes.',
    contract: 'session-undo-manager.test.ts, agent-undo.test.ts',
  },
  createUndoOrigin: {
    undo: 'agent-undo-system',
    why: 'Mints the per-session agent-undo origin (session.undoOrigin); filtered out of its own stack so undo-of-undo never stacks. Idle-LRU eviction destroys the session UndoManager, and a later undo gets the loud no-active-session refusal rather than a wrong-frame pop.',
    contract: 'agent-undo.test.ts, agent-sessions.eviction.test.ts',
  },
};

const RESERVED_UNDO_ROWS: Record<string, UndoRow> = {
  'machine-merge': {
    undo: 'system-not-undoable',
    why: 'Reserved for the conflict spec machine-merge landing; a system paired write excluded from undo pending cross-spec convergence. Becomes an ORIGIN_UNDO_CONTRACT row when the origin ships.',
    contract: 'reserved (conflict spec extension point)',
  },
};

const NON_CONTENT_ORIGINS: Record<string, string> = {
  OBSERVER_SYNC_ORIGIN:
    'The bridge itself — Observer A/B cross-CRDT self-skip; routing it through a UndoManager or the content sweep would loop.',
  EFFECT_CAPTURE_ORIGIN:
    'agent-effects Y.Map ring-buffer side-channel; touches no Y.Text/XmlFragment content.',
  CONFIG_VALIDATION_REVERT_ORIGIN:
    'Config-doc plane revert to last-known-good; markdown bridge bypassed, not content.',
  CONFIG_FILE_WATCHER_ORIGIN:
    'Config-doc plane file-watcher intake; markdown bridge bypassed, not content.',
  PARK_SNAPSHOT_ORIGIN:
    'Read-only serializeDoc wrapper; paired only so observers self-short-circuit, performs no content mutation.',
  ORIGIN_TREE_TO_TEXT:
    'Client observer-direction baseline marker; the client cross-CRDT write path is deleted (precedent #14), so it drives no content write.',
  ORIGIN_TEXT_TO_TREE:
    'Client observer-direction baseline marker; the client cross-CRDT write path is deleted (precedent #14), so it drives no content write.',
  SELECTION_ORIGIN_META_KEY:
    'A ProseMirror selection transaction-meta key, not a Y.Doc transaction origin.',
  DEFAULT_INTAKE_ORIGIN:
    'The uninstall-feedback submission source label, not a CRDT transaction origin.',
  LAUNCHER_FREE_ORIGIN:
    'The default provenance stamp on a menu-action dispatch, describing whether the surface that dispatched dismisses itself. It rides the menu-action bus, never a Y.Doc transaction.',
};

const HERE = import.meta.dirname;
const SRC_ROOTS = [
  join(HERE, '../../../server/src'),
  join(HERE, '../../../core/src'),
  join(HERE, '../../src'),
];
const AGENT_SESSIONS_PATH = join(HERE, '../../../server/src/agent-sessions.ts');

const ORIGIN_SEGMENT = /(^|_)ORIGIN(_|$)/;
const CONST_DECL = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;\n]+)?=/g;

function isScannedSource(fileName: string): boolean {
  if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) return false;
  return !(
    fileName.endsWith('.test.ts') ||
    fileName.endsWith('.test.tsx') ||
    fileName.endsWith('.test-helper.ts') ||
    fileName.endsWith('-test-harness.ts') ||
    fileName.endsWith('.d.ts')
  );
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (isScannedSource(entry)) out.push(full);
  }
}

function enumerateOriginConstants(): string[] {
  const files: string[] = [];
  for (const root of SRC_ROOTS) walkTsFiles(root, files);
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('ORIGIN')) continue;
    for (const match of source.matchAll(CONST_DECL)) {
      const name = match[1];
      if (ORIGIN_SEGMENT.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

function findUnclassified(originNames: string[]): string[] {
  return originNames.filter(
    (name) => !(name in ORIGIN_UNDO_CONTRACT) && !(name in NON_CONTENT_ORIGINS),
  );
}

const classifiedNames = [
  ...Object.keys(ORIGIN_UNDO_CONTRACT),
  ...Object.keys(NON_CONTENT_ORIGINS),
].sort();

describe('origin-undoability sweep', () => {
  const declared = enumerateOriginConstants();

  test('every declared origin constant carries an undoability ruling or a non-content reason', () => {
    expect(declared.length).toBeGreaterThanOrEqual(15);
    expect(findUnclassified(declared)).toEqual([]);
  });

  test('the undoability contract has no stale rows (every classified name is declared in source)', () => {
    const stale = classifiedNames.filter((name) => !declared.includes(name));
    expect(stale).toEqual([]);
  });

  test('the per-session factory write + undo origins are present', () => {
    const source = readFileSync(AGENT_SESSIONS_PATH, 'utf8');
    for (const factory of Object.keys(FACTORY_ORIGIN_ROWS)) {
      expect(source).toContain(`function ${factory}`);
    }
  });

  test('the sweep catches an unregistered content origin (planted positive)', () => {
    expect(findUnclassified(['__PLANTED_UNCLASSIFIED_ORIGIN__'])).toEqual([
      '__PLANTED_UNCLASSIFIED_ORIGIN__',
    ]);
    expect(findUnclassified(['FORM_WRITE_ORIGIN', '__PLANTED_UNCLASSIFIED_ORIGIN__'])).toEqual([
      '__PLANTED_UNCLASSIFIED_ORIGIN__',
    ]);
  });

  test('the reserved machine-merge undo row is documented for the conflict-spec extension point', () => {
    expect(RESERVED_UNDO_ROWS['machine-merge']?.undo).toBe('system-not-undoable');
  });
});
