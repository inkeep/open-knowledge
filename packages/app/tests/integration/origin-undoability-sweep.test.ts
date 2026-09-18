import { globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  clearsSharedUndoOnWholeTextReplacement?: true;
}

const ORIGIN_UNDO_CONTRACT: Record<string, UndoRow> = {
  AGENT_WRITE_ORIGIN: {
    undo: 'agent-session-um',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Typed exemplar for the agent-write origin; real writes carry the per-session session.origin. Undoable only by the server per-session UndoManager, never by a human Cmd+Z. The paired write reaches Y.Text(source) untracked: it leaves client undo history alone unless it replaces the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract:
      'session-undo-manager.test.ts, integration/agent-undo.test.ts, shared-undo-manager.test.ts',
  },
  FILE_WATCHER_ORIGIN: {
    undo: 'system-not-undoable',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Disk-to-CRDT intake (paired). A system origin tracked by no UndoManager. The paired write reaches Y.Text(source) untracked: it leaves client undo history alone unless it replaces the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract: 'external-change disk intake (system origin), shared-undo-manager.test.ts',
  },
  ROLLBACK_ORIGIN: {
    undo: 'system-not-undoable',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Timeline restore rewrites body + fragment as a paired write; deliberately not client-undoable, and it stales pre-rollback client undo items. The paired write reaches Y.Text(source) untracked: it leaves client undo history alone unless it replaces the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract: 'undo-after-rollback.test.ts, shared-undo-manager.test.ts',
  },
  MANAGED_RENAME_ORIGIN: {
    undo: 'system-not-undoable',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Managed-rename spine (paired). System origin tracked by no UndoManager. The paired write reaches Y.Text(source) untracked: it leaves client undo history alone unless it replaces the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract:
      'attribution-sweep-coverage.test.ts (identity threading), shared-undo-manager.test.ts',
  },
  GENERATED_ARTIFACT_ORIGIN: {
    undo: 'system-not-undoable',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Machine-maintained generated documents are reconciled through a paired system write and are tracked by no UndoManager. The paired write reaches Y.Text(source) untracked: it leaves client undo history alone unless it replaces the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract:
      'generated-artifact.test.ts, server-factory.test.ts (generated index wiring), shared-undo-manager.test.ts',
  },
  MERMAID_SOURCE_ORIGIN: {
    undo: 'system-not-undoable',
    why: 'Full Y.Text(source) seed/reconcile for standalone Mermaid, Excalidraw, and editable-text documents; system origin, markdown bridge gated off. A full replacement clears the Mermaid diagram UndoManager so stale label edits cannot replay into it; the editable-text pane exposes view-local CodeMirror history and the Excalidraw canvas its own scene history, so neither is reached by that clear.',
    contract: 'MermaidDocEditor.test.ts (system reconcile)',
  },
  MERMAID_DIAGRAM_EDIT_ORIGIN: {
    undo: 'client-editor-um',
    why: 'Diagram-label commits, tracked by the MermaidDocEditor own client Y.UndoManager so Cmd+Z reverts a label edit.',
    contract: 'MermaidDocEditor.test.ts (own UndoManager)',
  },
  FORM_WRITE_ORIGIN: {
    undo: 'no-undo-manager',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Frontmatter property-panel write to the YAML region of Y.Text; single-root, captured by no editor UndoManager, and, being partial, it leaves client undo history alone (only an untracked whole-text replacement clears the shared manager).',
    contract: 'write-surface-undo-exclusion.test.ts, shared-undo-manager.test.ts',
  },
  LINT_FIX_ORIGIN: {
    undo: 'no-undo-manager',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Client markdownlint auto-fix writing Y.Text(source) directly; captured by no editor UndoManager. Driven from the Problems panel and the visual editor, and, being partial, it leaves client undo history alone (only an untracked whole-text replacement clears the shared manager).',
    contract: 'write-surface-undo-exclusion.test.ts, shared-undo-manager.test.ts',
  },
  SOURCE_PASTE_ORIGIN: {
    undo: 'no-undo-manager',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Chunked large source-mode paste writing Y.Text(source) directly, bypassing CM6 dispatch; captured by no editor UndoManager. Issued only from the source view paste handler, but the chunked insert yields per animation frame, so a tail chunk can land after a mode flip; being partial, it leaves client undo history alone (only an untracked whole-text replacement clears the shared manager).',
    contract: 'write-surface-undo-exclusion.test.ts, shared-undo-manager.test.ts',
  },
  PROJECTION_WRITE_ORIGIN: {
    undo: 'client-editor-um',
    why: "The single-CRDT WYSIWYG write: a ProseMirror edit re-serialized to one block-scoped Y.Text(source) splice on the client. Tracked by the document's ONE shared Y.UndoManager — the same manager source mode drives through yCollab — which is what makes undo a single global LIFO across both surfaces instead of two stacks over two CRDT types. Behind PROJECTION_BINDING_ENABLED; with the flag off nothing writes under it.",
    contract: 'cross-mode-undo-projection.test.ts, projection-binding.test.ts',
  },
  TAB_REPLAY_ORIGIN: {
    undo: 'replay-not-undoable',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Recovery replay of buffered updates onto a recycled provider. The replayed bytes are durable but not Cmd+Z-undoable — post-recycle, the last pre-hiccup edits are recovery machinery, not a fresh user action. The replay reaches Y.Text(source) untracked: it leaves client undo history alone unless it replaces the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract: 'undo-recycle-reset.test.ts, shared-undo-manager.test.ts',
  },
};

const FACTORY_ORIGIN_ROWS: Record<string, UndoRow> = {
  createSessionOrigin: {
    undo: 'agent-session-um',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Mints the per-session frozen agent-write origin (session.origin); object-identity-unique, added to the session UndoManager trackedOrigins so only that session can undo its writes. Its paired writes reach Y.Text(source) untracked: an agent `replace` is a whole-text replacement and clears the shared manager; a partial write leaves client undo history alone.',
    contract:
      'session-undo-manager.test.ts, integration/agent-undo.test.ts, shared-undo-manager.test.ts',
  },
  createUndoOrigin: {
    undo: 'agent-undo-system',
    clearsSharedUndoOnWholeTextReplacement: true,
    why: 'Mints the per-session agent-undo origin (session.undoOrigin); filtered out of its own stack so undo-of-undo never stacks. Idle-LRU eviction destroys the session UndoManager, and a later undo gets the loud no-active-session refusal rather than a wrong-frame pop. Its undo writes reach Y.Text(source) untracked and leave client undo history alone unless they replace the whole text (only an untracked whole-text replacement clears the shared manager).',
    contract:
      'integration/agent-undo.test.ts, agent-sessions.eviction.test.ts, shared-undo-manager.test.ts',
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
const CONTRACT_SEARCH_ROOTS = [
  ...SRC_ROOTS,
  join(HERE, '..'),
  join(HERE, '../../../cli/src'),
  join(HERE, '../../../desktop/src'),
];

const ORIGIN_SEGMENT = /(^|_)ORIGIN(_|$)/;
const CONST_DECL = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;\n]+)?=/g;
const CONTRACT_TEST_FILE = /[\w./-]+\.test\.tsx?\b/g;

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

function enumerateContractTestFiles(): Array<{ owner: string; file: string }> {
  const rows: Array<[string, UndoRow]> = [
    ...Object.entries(ORIGIN_UNDO_CONTRACT),
    ...Object.entries(FACTORY_ORIGIN_ROWS),
    ...Object.entries(RESERVED_UNDO_ROWS),
  ];
  return rows.flatMap(([owner, row]) =>
    (row.contract.match(CONTRACT_TEST_FILE) ?? []).map((file) => ({ owner, file })),
  );
}

function rowsRuledByWholeTextClear(): Array<[string, UndoRow]> {
  return [
    ...Object.entries(ORIGIN_UNDO_CONTRACT),
    ...Object.entries(FACTORY_ORIGIN_ROWS),
    ...Object.entries(RESERVED_UNDO_ROWS),
  ].filter(([, row]) => row.clearsSharedUndoOnWholeTextReplacement);
}

function contractFileHits(file: string): string[] {
  return CONTRACT_SEARCH_ROOTS.flatMap((root) =>
    globSync(`**/${file}`, { cwd: root, exclude: ['node_modules/**'] }).map((hit) =>
      join(root, hit),
    ),
  );
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

  test('every test file named in a contract ruling resolves to exactly one path', () => {
    const unresolved = enumerateContractTestFiles()
      .map(({ owner, file }) => ({ owner, file, hits: contractFileHits(file) }))
      .filter(({ hits }) => hits.length !== 1);
    expect(unresolved).toEqual([]);
  });

  test('every ruling about the whole-text clear cites the shared undo manager contract', () => {
    expect(rowsRuledByWholeTextClear().length).toBeGreaterThanOrEqual(11);
    const missing = rowsRuledByWholeTextClear()
      .filter(([, row]) => !row.contract.includes('shared-undo-manager.test.ts'))
      .map(([owner]) => owner);

    expect(missing).toEqual([]);
  });

  test('the contract resolver catches an invented file (planted positive)', () => {
    expect(contractFileHits('__never_a_real__.test.ts')).toEqual([]);
    expect(contractFileHits(basename(import.meta.filename))).toHaveLength(1);
  });

  test('the reserved machine-merge undo row is documented for the conflict-spec extension point', () => {
    expect(RESERVED_UNDO_ROWS['machine-merge']?.undo).toBe('system-not-undoable');
  });
});
