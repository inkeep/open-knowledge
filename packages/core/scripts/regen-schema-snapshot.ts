/**
 * One-shot regenerator for `src/schema-snapshot.json`. Mirror of
 * `captureSchemaShape` in `src/schema-invariant.test.ts`. Run via:
 *
 *   bun run packages/core/scripts/regen-schema-snapshot.ts
 *
 * After running, diff the snapshot file — landing it requires the diff to
 * be purely additive (precedent #9).
 *
 * Output shape MUST stay byte-aligned with `captureSchemaShape` — including
 * `marks` (which the schema-invariant tests read to verify
 * mark add-only invariants). Omitting `marks` here would silently strip
 * mark coverage from the snapshot the next time someone regenerates.
 */
import { writeFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import { sharedExtensions } from '../src/extensions/shared.ts';

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
  marks: Record<string, MarkShape>;
  extensionOrder: string[];
}

const schema = getSchema(sharedExtensions);
const nodes: Record<string, NodeShape> = {};
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
const marks: Record<string, MarkShape> = {};
for (const [name, markType] of Object.entries(schema.marks)) {
  const attrs: Record<string, AttrShape> = {};
  for (const [attrName, attrSpec] of Object.entries(markType.spec.attrs ?? {})) {
    attrs[attrName] = {
      hasDefault: 'default' in (attrSpec as Record<string, unknown>),
    };
  }
  marks[name] = {
    attrs,
    // `excludes: undefined` means "exclude marks of the same type" — PM
    // canonicalizes this to the mark's own name. `''` means "coexist with
    // everything" (Code mark's deliberate widening per CLAUDE.md STOP).
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

const snap: SchemaSnapshot = { nodes, marks, extensionOrder };
const out = new URL('../src/schema-snapshot.json', import.meta.url).pathname;
writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`);
console.log(`Wrote ${out}`);
