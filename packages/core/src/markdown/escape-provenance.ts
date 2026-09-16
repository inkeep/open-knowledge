import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Root, Text } from 'mdast';
import type { CompileContext, Extension } from 'mdast-util-from-markdown';
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference';
import type { Parser, Plugin, Processor } from 'unified';
import { visit } from 'unist-util-visit';
import type { EscapeProvenanceEntry } from './mdast-augmentation.ts';

const MARKER_RANGE_START = 0xe200;
const MARKER_RANGE_END = 0xf8ff;
const CHARACTER_REFERENCE_RE = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/g;

function decodedReferenceProjection(source: string): string {
  CHARACTER_REFERENCE_RE.lastIndex = 0;
  return source.replace(CHARACTER_REFERENCE_RE, (reference) => {
    const body = reference.slice(1, -1);
    if (body.startsWith('#')) {
      const hexadecimal = body[1] === 'x' || body[1] === 'X';
      return decodeNumericCharacterReference(
        body.slice(hexadecimal ? 2 : 1),
        hexadecimal ? 16 : 10,
      );
    }
    const decoded = decodeNamedCharacterReference(body);
    return decoded === false ? reference : decoded;
  });
}

function inspectMarkerOccupancy(values: readonly string[]): {
  occupied: ReadonlySet<number>;
  longestStartRun: number;
} {
  const occupied = new Set<number>();
  let longestStartRun = 0;
  for (const value of values) {
    let currentStartRun = 0;
    for (const char of value) {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) continue;
      if (codePoint >= MARKER_RANGE_START && codePoint <= MARKER_RANGE_END) {
        occupied.add(codePoint);
      }
      if (codePoint === MARKER_RANGE_START) {
        currentStartRun += 1;
        longestStartRun = Math.max(longestStartRun, currentStartRun);
      } else {
        currentStartRun = 0;
      }
    }
  }
  return { occupied, longestStartRun };
}

export function selectEscapeProvenanceMarker(source: string): string {
  const projection = decodedReferenceProjection(source);
  const { occupied, longestStartRun } = inspectMarkerOccupancy([source, projection]);
  for (let codePoint = MARKER_RANGE_START; codePoint <= MARKER_RANGE_END; codePoint += 1) {
    if (!occupied.has(codePoint)) return String.fromCharCode(codePoint);
  }
  const markerUnit = String.fromCharCode(MARKER_RANGE_START);
  const terminator = String.fromCharCode(MARKER_RANGE_START + 1);
  return markerUnit.repeat(longestStartRun + 1) + terminator;
}

function createEscapeExtension(marker: string): Extension {
  return {
    exit: {
      characterEscapeValue(this: CompileContext, token): void {
        const tail = this.stack.pop() as Text;
        tail.value += marker + this.sliceSerialize(token);
        if (tail.position) {
          tail.position.end = {
            line: token.end.line,
            column: token.end.column,
            offset: token.end.offset,
          };
        }
      },
    },
    transforms: [
      (tree) => {
        visit(tree, (node) => {
          if (node.type === 'text') {
            const entries: EscapeProvenanceEntry[] = [];
            let value = '';
            let cursor = 0;
            for (;;) {
              const markerAt = node.value.indexOf(marker, cursor);
              if (markerAt === -1) break;
              value += node.value.slice(cursor, markerAt);
              const escapedChar = node.value.slice(
                markerAt + marker.length,
                markerAt + marker.length + 1,
              );
              entries.push({ offset: value.length, char: escapedChar });
              cursor = markerAt + marker.length;
            }
            value += node.value.slice(cursor);
            node.value = value;
            node.data ??= {};
            node.data.escapedChars = entries;
            return;
          }
          const record = node as unknown as Record<string, unknown>;
          for (const [key, field] of Object.entries(record)) {
            if (typeof field === 'string') record[key] = field.replaceAll(marker, '');
          }
        });
        return tree;
      },
    ],
  };
}

function withSynchronousReentrantEscapeProvenanceParser(
  baseParser: Parser<Root>,
  processor: Processor,
): Parser<Root> {
  let activeExtension: Extension | undefined;
  return (document, file) => {
    const data = processor.data() as { fromMarkdownExtensions?: Extension[] };
    data.fromMarkdownExtensions ??= [];
    const extensions = data.fromMarkdownExtensions;
    const extension = createEscapeExtension(selectEscapeProvenanceMarker(document));
    const outerExtension = activeExtension;
    const outerExtensionIndex = outerExtension ? extensions.lastIndexOf(outerExtension) : -1;
    if (outerExtensionIndex >= 0) {
      extensions.splice(outerExtensionIndex, 1, extension);
    } else {
      extensions.push(extension);
    }
    activeExtension = extension;
    try {
      return baseParser(document, file);
    } finally {
      const extensionIndex = extensions.lastIndexOf(extension);
      if (extensionIndex >= 0) {
        if (outerExtension && outerExtensionIndex >= 0) {
          extensions.splice(extensionIndex, 1, outerExtension);
        } else {
          extensions.splice(extensionIndex, 1);
        }
      }
      activeExtension = outerExtension;
    }
  };
}

export const escapeProvenancePlugin: Plugin<[], Root> = function () {
  const processor = this as Processor;
  processor.parser = withSynchronousReentrantEscapeProvenanceParser(
    processor.parser as Parser<Root>,
    processor,
  );
};
