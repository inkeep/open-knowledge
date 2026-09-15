import type { Nodes, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { protectPattern } from './entity-ref-guard.ts';
import type { EntityReferenceSpan, EscapeProvenanceEntry } from './mdast-augmentation.ts';

const BACKSLASH_ESCAPE_PUA_MARK = '';

export const BACKSLASH_GUARD_SUBSTITUTIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '\\', to: BACKSLASH_ESCAPE_PUA_MARK },
];

const BACKSLASH_ESCAPE_RE = /\\</g;

export function encodeBackslashEscapes(source: string): string {
  return protectPattern(source, BACKSLASH_ESCAPE_RE, (match) => {
    return `${BACKSLASH_ESCAPE_PUA_MARK}${match.slice(1)}`;
  });
}

export function restoreBackslashEscapesPlugin(): ReturnType<Plugin<[], Root>> {
  return (tree: Root) => {
    visit(tree, (node: Nodes) => {
      const rec = node as unknown as Record<string, unknown>;
      if (typeof rec.value === 'string' && rec.value.includes(BACKSLASH_ESCAPE_PUA_MARK)) {
        if (node.type === 'text') {
          const oldValue = node.value;
          const sourceOffsets = new Array<number>(oldValue.length + 1);
          const restored: EscapeProvenanceEntry[] = [];
          let value = '';
          for (let index = 0; index < oldValue.length; index += 1) {
            sourceOffsets[index] = value.length;
            if (oldValue[index] === BACKSLASH_ESCAPE_PUA_MARK) {
              restored.push({ offset: value.length, char: oldValue[index + 1] ?? '' });
            } else {
              value += oldValue[index];
            }
          }
          sourceOffsets[oldValue.length] = value.length;
          const existing = node.data?.escapedChars ?? [];
          const rebasedExisting = existing.map((entry) => ({
            ...entry,
            offset: sourceOffsets[entry.offset] ?? entry.offset,
          }));
          const escapedChars = [...rebasedExisting, ...restored]
            .map((entry) => ({
              ...entry,
            }))
            .sort(
              (left, right) => left.offset - right.offset || left.char.localeCompare(right.char),
            )
            .filter(
              (entry, index, entries) =>
                index === 0 ||
                entry.offset !== entries[index - 1]?.offset ||
                entry.char !== entries[index - 1]?.char,
            );
          const entityRefSpans = node.data?.entityRefSpans?.map((span): EntityReferenceSpan => {
            const start = sourceOffsets[span.offset] ?? span.offset;
            const end = sourceOffsets[span.offset + span.length] ?? span.offset + span.length;
            return { ...span, offset: start, length: end - start };
          });
          node.value = value;
          node.data ??= {};
          node.data.escapedChars = escapedChars;
          if (entityRefSpans) node.data.entityRefSpans = entityRefSpans;
        } else {
          rec.value = (rec.value as string).split(BACKSLASH_ESCAPE_PUA_MARK).join('');
        }
      }
      for (const key of ['url', 'title', 'alt'] as const) {
        const v = rec[key];
        if (typeof v === 'string' && v.includes(BACKSLASH_ESCAPE_PUA_MARK)) {
          rec[key] = v.split(BACKSLASH_ESCAPE_PUA_MARK).join('');
        }
      }
    });
  };
}
