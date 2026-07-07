/**
 * Schema add-only invariant enforcement.
 *
 * This test captures every node type + attrs + default-presence + content
 * expression AND the sharedExtensions array ordering. It fails on:
 *   - Removed node type
 *   - Removed attr
 *   - Attr missing default
 *   - Content expression narrowed
 *   - sharedExtensions ordering changed
 *
 * Adding new nodes/attrs with defaults causes a snapshot mismatch — regenerate
 * via `bun run generate-schema-snapshot` (or manually update schema-snapshot.json)
 * and verify the diff is purely additive before committing.
 *
 * Rationale: y-prosemirror@1.3.7 destructively deletes Y.Items whose
 * schema.node() throws. The delete is multi-peer replicated and undo-resistant.
 * Any schema narrowing = silent data loss.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import { sharedExtensions } from './extensions/shared.ts';

// ── Schema shape capture ────────────────────────────────────────────

interface AttrShape {
  hasDefault: boolean;
}

interface NodeShape {
  attrs: Record<string, AttrShape>;
  content: string;
  group: string;
  inline: boolean;
  atom: boolean;
}

interface MarkShape {
  attrs: Record<string, AttrShape>;
  excludes: string;
  group: string;
  inclusive: boolean;
  spanning: boolean;
}

interface SchemaSnapshot {
  nodes: Record<string, NodeShape>;
  marks?: Record<string, MarkShape>;
  extensionOrder: string[];
}

function captureSchemaShape(): SchemaSnapshot {
  const schema = getSchema(sharedExtensions);
  const nodes: Record<string, NodeShape> = {};
  const marks: Record<string, MarkShape> = {};

  for (const [name, nodeType] of Object.entries(schema.nodes)) {
    const attrs: Record<string, AttrShape> = {};
    for (const [attrName, attrSpec] of Object.entries(nodeType.spec.attrs ?? {})) {
      attrs[attrName] = {
        hasDefault: 'default' in (attrSpec as Record<string, unknown>),
      };
    }
    nodes[name] = {
      attrs,
      content: nodeType.spec.content ?? '',
      group: nodeType.spec.group ?? '',
      inline: !!nodeType.spec.inline,
      atom: !!nodeType.spec.atom,
    };
  }

  for (const [name, markType] of Object.entries(schema.marks)) {
    const attrs: Record<string, AttrShape> = {};
    for (const [attrName, attrSpec] of Object.entries(markType.spec.attrs ?? {})) {
      attrs[attrName] = {
        hasDefault: 'default' in (attrSpec as Record<string, unknown>),
      };
    }
    marks[name] = {
      attrs,
      // `excludes` controls mark co-occurrence (STOP rule on Code
      // mark's deliberate widening). `undefined` means "exclude marks of
      // the same type," which PM canonicalizes to the mark's name; `''`
      // means "coexist with everything" (widened state).
      excludes: typeof markType.spec.excludes === 'string' ? markType.spec.excludes : name,
      group: markType.spec.group ?? '',
      inclusive: markType.spec.inclusive !== false,
      spanning: markType.spec.spanning !== false,
    };
  }

  const extensionOrder = sharedExtensions.map((ext) => {
    if ('name' in ext && typeof ext.name === 'string') return ext.name;
    if ('configure' in ext) return '(configured)';
    return String(ext);
  });

  return { nodes, marks, extensionOrder };
}

// ── Snapshot loading ────────────────────────────────────────────────

const SNAPSHOT_PATH = new URL('./schema-snapshot.json', import.meta.url).pathname;

function loadSnapshot(): SchemaSnapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as SchemaSnapshot;
}

// ── Allowed narrowings ──────────────────────────────────────────────

/**
 * Explicit narrowings that have been authorized against precedent #9 with
 * linked spec evidence. Every entry names (a) the exact node-attribute
 * combination being narrowed and (b) the spec citation explaining why the
 * y-prosemirror schema-throw safety net is sufficient coverage. Adding a new
 * entry REQUIRES the companion spec section AND a live-fire regression test in
 * `packages/app/tests/integration/`.
 *
 * This is the NOT a loophole — it's a registry that surfaces every
 * authorized narrowing in one place so future audits can enumerate them
 * without re-reading specs.
 */
interface AllowedNarrowing {
  nodeType: string;
  kind: 'content' | 'attr-removed';
  /** Attr name for `attr-removed`; undefined otherwise. */
  attrName?: string;
  specRef: string;
  regressionTestRef: string;
}

const ALLOWED_NARROWINGS: AllowedNarrowing[] = [
  // jsxInline greenfield narrowing: atom-widening (allowed via content
  // expression exception) plus attr removals listed explicitly.
  {
    nodeType: 'jsxInline',
    kind: 'content',
    specRef: 'specs/2026-04-14-component-blocks-v2/SPEC.md §FR-4 / NG14',
    regressionTestRef:
      'packages/app/tests/integration/jsx-schema-narrowing-safety.test.ts (SH05: pre-narrowing jsxInline materialization) + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts (R13 substitution on schema throw)',
  },
  {
    nodeType: 'jsxInline',
    kind: 'attr-removed',
    attrName: 'attributes',
    specRef: 'specs/2026-04-14-component-blocks-v2/SPEC.md §FR-4 / NG14',
    regressionTestRef:
      'packages/app/tests/integration/jsx-schema-narrowing-safety.test.ts (SH05: pre-narrowing jsxInline materialization) + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts (R13 substitution on schema throw)',
  },
  {
    nodeType: 'jsxInline',
    kind: 'attr-removed',
    attrName: 'sourceRaw',
    specRef: 'specs/2026-04-14-component-blocks-v2/SPEC.md §FR-4 / NG14',
    regressionTestRef:
      'packages/app/tests/integration/jsx-schema-narrowing-safety.test.ts (SH05: pre-narrowing jsxInline materialization) + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts (R13 substitution on schema throw)',
  },
  // Drop the legacy `content` attr
  // on `jsxComponent`. It was dead storage — duplicated on every node but
  // never read (the PM `content: 'block*'` content expression handles
  // actual child content; the attr was a relic of an earlier iteration).
  // The dead `(pmNode.attrs.content ? null : null)` ternary in
  // `packages/core/src/markdown/index.ts` was removed alongside. Because
  // the attr was unused, there is no Y.Item data to migrate — the narrow
  // is safe under precedent #9's "attrs are add-only" rule modulo this
  // registration. The regression suite below + the y-prosemirror
  // substitution test jointly prove that removing this attr cannot cause
  // Y.Item data loss on downstream peers.
  {
    nodeType: 'jsxComponent',
    kind: 'attr-removed',
    attrName: 'content',
    specRef:
      'specs/2026-04-23-cb-v2-md-foundation/SPEC.md + pre-QA review M4 (packages/core/src/extensions/jsx-component.ts attrs L44 cleanup)',
    regressionTestRef:
      'packages/core/src/extensions/jsx-component.test.ts + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts',
  },
  // Three rendered:false attrs (`sourceForm`/`target`/`anchor`) previously
  // lived on the PM `image` node solely to round-trip inline-position
  // `text ![[file.png]] more text` through a PM `image` shape. Mid-paragraph
  // inline image is supported only in word-processor-lineage editors (Word,
  // Confluence, Google Docs); markdown-outliner editors (Obsidian/Logseq/
  // Roam) treat it as partial-at-best, and inline mid-paragraph video/audio
  // is unsupported in those substrates. The editor collapses to one
  // consistent path — block-context promotes to `jsxComponent('WikiEmbed*')`,
  // inline-position falls through to the link-mark chip (same treatment as
  // inline `![[clip.mp4]]`). After the cut, no parser/serializer emits or
  // reads these three attrs; they are dead storage on the PM image node.
  // Y-tiptap silently drops unknown attrs on deserialization, so any
  // in-flight IDB-cached PM `image` carrying them loses them on next load
  // (chip shape rehydrates on next disk-ack roundtrip — the markdown bytes
  // preserve identity).
  {
    nodeType: 'image',
    kind: 'attr-removed',
    attrName: 'sourceForm',
    specRef:
      'inline-image kill — three rendered:false attrs on PM `image` schema (`sourceForm`/`target`/`anchor`) removed when inline-position embeds collapsed onto the link-mark chip path; no parser/serializer reads or emits these attrs after the cut',
    regressionTestRef:
      'packages/core/src/markdown/handlers.test.ts (inline-position chip-path test) + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts (R13 substitution on schema throw)',
  },
  {
    nodeType: 'image',
    kind: 'attr-removed',
    attrName: 'target',
    specRef:
      'inline-image kill — three rendered:false attrs on PM `image` schema (`sourceForm`/`target`/`anchor`) removed when inline-position embeds collapsed onto the link-mark chip path; no parser/serializer reads or emits these attrs after the cut',
    regressionTestRef:
      'packages/core/src/markdown/handlers.test.ts (inline-position chip-path test) + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts (R13 substitution on schema throw)',
  },
  {
    nodeType: 'image',
    kind: 'attr-removed',
    attrName: 'anchor',
    specRef:
      'inline-image kill — three rendered:false attrs on PM `image` schema (`sourceForm`/`target`/`anchor`) removed when inline-position embeds collapsed onto the link-mark chip path; no parser/serializer reads or emits these attrs after the cut',
    regressionTestRef:
      'packages/core/src/markdown/handlers.test.ts (inline-position chip-path test) + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts (R13 substitution on schema throw)',
  },
];

function isAllowedNarrowing(
  nodeType: string,
  kind: AllowedNarrowing['kind'],
  attrName?: string,
): boolean {
  return ALLOWED_NARROWINGS.some(
    (a) => a.nodeType === nodeType && a.kind === kind && a.attrName === attrName,
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe('R10: schema add-only invariant', () => {
  const current = captureSchemaShape();
  const snapshot = loadSnapshot();

  test('schema-snapshot.json exists', () => {
    expect(snapshot).not.toBeNull();
  });

  if (!snapshot) return;

  test('no node types removed', () => {
    for (const nodeType of Object.keys(snapshot.nodes)) {
      expect(current.nodes[nodeType]).toBeDefined();
    }
  });

  test('no attrs removed from existing node types (outside allowed narrowings)', () => {
    for (const [nodeType, expected] of Object.entries(snapshot.nodes)) {
      const actual = current.nodes[nodeType];
      if (!actual) continue; // covered by "no node types removed"
      for (const attrName of Object.keys(expected.attrs)) {
        if (actual.attrs[attrName] !== undefined) continue;
        if (isAllowedNarrowing(nodeType, 'attr-removed', attrName)) continue;
        // Unauthorized removal — fail explicitly.
        throw new Error(
          `Schema NARROWED — attr '${attrName}' removed from node type '${nodeType}'. ` +
            'This violates precedent #9 unless registered in ALLOWED_NARROWINGS with spec evidence.',
        );
      }
    }
  });

  test('all attrs have default values', () => {
    for (const [, shape] of Object.entries(current.nodes)) {
      for (const [, attrShape] of Object.entries(shape.attrs)) {
        expect(attrShape.hasDefault).toBe(true);
      }
    }
  });

  test('content expressions not narrowed (superset check)', () => {
    for (const [nodeType, expected] of Object.entries(snapshot.nodes)) {
      const actual = current.nodes[nodeType];
      if (!actual) continue;
      // Content expression must be identical (strict-equality check).
      // Widening is legitimate (e.g. block+ → block* broadens) but
      // ProseMirror content expressions lack a structural-subset operator
      // in userspace — detecting "actual is a superset of expected"
      // requires parsing the expression grammar. So the ratchet treats
      // ANY change as suspect: when the expression changes, the delta
      // must be explicitly registered in ALLOWED_NARROWINGS (with
      // `kind: 'content'`) AND the schema-snapshot.json must be
      // regenerated.
      //
      // This is a registry with social enforcement, not a
      // mechanical close on the same-commit escape hatch. A developer who
      // narrows the schema AND regenerates the snapshot in one commit
      // produces `expected === actual` here and the test silently passes.
      // Both the snapshot diff and the ALLOWED_NARROWINGS update are
      // required to land for the change to be auditable; PR review reads
      // the registry diff as the load-bearing gate. A truly mechanical
      // close requires a separate baseline file + a regen script that
      // refuses to run unless the registry has a matching entry; that
      // hardening is tracked but not in scope for the foundation.
      if (expected.content === actual.content) continue; // unchanged — OK
      if (expected.content !== '' && isAllowedNarrowing(nodeType, 'content')) {
        // Explicit registration consulted — delta is authorized.
        continue;
      }
      // Unauthorized content-expression change (narrowing OR widening
      // without registration). Fail loudly — if this is a legit widening,
      // register it in ALLOWED_NARROWINGS with `kind: 'content'`, spec
      // ref, and regression-test ref (same pattern as attr-removed).
      throw new Error(
        `Schema content expression changed on node type '${nodeType}': ` +
          `'${expected.content}' → '${actual.content}'. ` +
          'This requires an ALLOWED_NARROWINGS entry with kind:"content" + ' +
          'spec evidence. Precedent #9 (schema add-only) / R13 y-prosemirror ' +
          'schema-throw safety net relies on this ratchet to prevent silent ' +
          'Y.Item data loss on downstream peers.',
      );
    }
  });

  test('sharedExtensions ordering unchanged', () => {
    expect(current.extensionOrder).toEqual(snapshot.extensionOrder);
  });

  // ── Mark invariants (same y-prosemirror
  //    destructive-delete risk as nodes; see WARN rule on Code
  //    mark's deliberately-widened excludes). `current.marks` is always
  //    captured; `snapshot.marks` may be absent for older snapshots
  //    written without mark coverage — the branch gracefully skips
  //    mark-specific assertions in that case. Once the snapshot carries
  //    `marks`, a narrowed `excludes` or removed attr/mark fails loudly.
  const snapshotMarks = snapshot.marks;
  if (snapshotMarks) {
    test('no marks removed', () => {
      for (const markName of Object.keys(snapshotMarks)) {
        expect(current.marks?.[markName]).toBeDefined();
      }
    });

    test('no attrs removed from existing marks', () => {
      for (const [markName, expected] of Object.entries(snapshotMarks)) {
        const actual = current.marks?.[markName];
        if (!actual) continue;
        for (const attrName of Object.keys(expected.attrs)) {
          expect(actual.attrs[attrName]).toBeDefined();
        }
      }
    });

    test('all mark attrs have default values', () => {
      for (const [, shape] of Object.entries(current.marks ?? {})) {
        for (const [, attrShape] of Object.entries(shape.attrs)) {
          expect(attrShape.hasDefault).toBe(true);
        }
      }
    });

    test('mark excludes not narrowed (STOP rule on Code mark widening)', () => {
      // Narrowing `excludes` re-adds mark-exclusion constraints a
      // previous build had relaxed. Cannonical bug case: upstream
      // Tiptap bumping `Code.excludes` back to `_`. The check: current
      // `excludes` must be
      // equal to OR wider than the snapshot's. "Wider" is hard to
      // generalize for PM mark-group expressions, so we treat `''`
      // (coexist with everything) as universally wider and otherwise
      // demand identity — conservative but matches the actual risk.
      for (const [markName, expected] of Object.entries(snapshotMarks)) {
        const actual = current.marks?.[markName];
        if (!actual) continue;
        if (actual.excludes === '') continue; // widest — always acceptable
        expect(actual.excludes).toBe(expected.excludes);
      }
    });
  }

  test('rawMdxFallback node can be constructed at runtime (R13 patch guard)', () => {
    // The y-prosemirror patch substitutes rawMdxFallback on schema.node()
    // throw. If this construction itself fails, the patch silently drops the
    // node from the PM view. This test ensures the substitution path works.
    const schema = getSchema(sharedExtensions);
    const node = schema.node('rawMdxFallback', { reason: 'test' }, [schema.text('test')]);
    expect(node.type.name).toBe('rawMdxFallback');
    expect(node.textContent).toBe('test');
  });

  test('snapshot matches current schema (regenerate if additive-only changes)', () => {
    // This catches NEW additions that haven't been committed to the snapshot.
    // When adding a new node/attr, regenerate the snapshot and verify the
    // diff is purely additive.
    const currentJson = JSON.stringify(current, null, 2);
    const snapshotJson = JSON.stringify(snapshot, null, 2);
    if (currentJson !== snapshotJson) {
      // Provide a helpful diff message
      const newNodes = Object.keys(current.nodes).filter((n) => !(n in snapshot.nodes));
      const missingNodes = Object.keys(snapshot.nodes).filter((n) => !(n in current.nodes));
      if (missingNodes.length > 0) {
        throw new Error(
          `Schema NARROWED — removed node types: ${missingNodes.join(', ')}. This is forbidden by R10.`,
        );
      }
      if (newNodes.length > 0) {
        throw new Error(
          `Schema snapshot outdated — new node types: ${newNodes.join(', ')}. ` +
            'Regenerate schema-snapshot.json and verify the diff is additive-only.',
        );
      }
      throw new Error(
        'Schema snapshot mismatch. Regenerate schema-snapshot.json and verify the diff is additive-only. ' +
          'If removing or renaming attrs/types, STOP — this violates R10 (y-prosemirror data loss).',
      );
    }
  });
});
