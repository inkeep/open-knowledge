import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import { sharedExtensions } from './extensions/shared.ts';


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


const SNAPSHOT_PATH = new URL('./schema-snapshot.json', import.meta.url).pathname;

function loadSnapshot(): SchemaSnapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as SchemaSnapshot;
}


interface AllowedNarrowing {
  nodeType: string;
  kind: 'content' | 'attr-removed';
  attrName?: string;
  specRef: string;
  regressionTestRef: string;
}

const ALLOWED_NARROWINGS: AllowedNarrowing[] = [
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
  {
    nodeType: 'jsxComponent',
    kind: 'attr-removed',
    attrName: 'content',
    specRef:
      'specs/2026-04-23-cb-v2-md-foundation/SPEC.md + pre-QA review M4 (packages/core/src/extensions/jsx-component.ts attrs L44 cleanup)',
    regressionTestRef:
      'packages/core/src/extensions/jsx-component.test.ts + packages/app/tests/integration/y-tiptap-schema-throw-substitution.test.ts',
  },
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
      if (expected.content === actual.content) continue; // unchanged — OK
      if (expected.content !== '' && isAllowedNarrowing(nodeType, 'content')) {
        continue;
      }
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
      for (const [markName, expected] of Object.entries(snapshotMarks)) {
        const actual = current.marks?.[markName];
        if (!actual) continue;
        if (actual.excludes === '') continue; // widest — always acceptable
        expect(actual.excludes).toBe(expected.excludes);
      }
    });
  }

  test('rawMdxFallback node can be constructed at runtime (R13 patch guard)', () => {
    const schema = getSchema(sharedExtensions);
    const node = schema.node('rawMdxFallback', { reason: 'test' }, [schema.text('test')]);
    expect(node.type.name).toBe('rawMdxFallback');
    expect(node.textContent).toBe('test');
  });

  test('snapshot matches current schema (regenerate if additive-only changes)', () => {
    const currentJson = JSON.stringify(current, null, 2);
    const snapshotJson = JSON.stringify(snapshot, null, 2);
    if (currentJson !== snapshotJson) {
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
