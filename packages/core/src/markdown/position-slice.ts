import type { Blockquote, FootnoteDefinition, ListItem, Nodes, Root } from 'mdast';
import type { MdxFlowExpression, MdxTextExpression } from 'mdast-util-mdx-expression';
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx-jsx';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { type EscapeProvenanceEntry, hasEscapeProvenance } from './mdast-augmentation.ts';

const ESCAPABLE_CHARS = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

export function splitGfmCellSegments(rowSrc: string): string[] {
  const segments: string[] = [];
  let cur = '';
  for (let i = 0; i < rowSrc.length; i++) {
    const c = rowSrc[i];
    if (c === '\\' && i + 1 < rowSrc.length && rowSrc[i + 1] === '|') {
      cur += `${c}|`;
      i++;
      continue;
    }
    if (c === '|') {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments;
}

export function applyPositionSliceToNode(
  node: Nodes,
  source: string,
  debug: boolean = false,
  parent?: { type?: string },
): void {
  if (!source) return;
  const pos = node.position;
  if (!pos || typeof pos.start?.offset !== 'number') {
    if (debug) {
      console.warn(
        `[position-slice] node type=${node.type} has no position — fidelity defaults apply`,
      );
    }
    return;
  }

  const startOff = pos.start.offset;
  const endOff = pos.end?.offset ?? startOff;

  if (startOff < 0 || endOff > source.length) {
    if (debug) {
      console.warn(
        `[position-slice] node type=${node.type} position out of bounds: ` +
          `start=${startOff} end=${endOff} sourceLen=${source.length}`,
      );
    }
    return;
  }

  node.data ??= {};

  switch (node.type) {
    case 'text': {
      const raw = source.slice(startOff, endOff);
      const value: string = node.value ?? '';
      if (!hasEscapeProvenance(node.data) && raw.length > value.length && raw.includes('\\')) {
        const escaped: EscapeProvenanceEntry[] = [];
        let rawIdx = 0;
        let valIdx = 0;
        while (rawIdx < raw.length && valIdx < value.length) {
          if (
            raw[rawIdx] === '\\' &&
            rawIdx + 1 < raw.length &&
            ESCAPABLE_CHARS.has(raw[rawIdx + 1]) &&
            value[valIdx] === raw[rawIdx + 1]
          ) {
            escaped.push({ offset: valIdx, char: raw[rawIdx + 1] });
            rawIdx += 2;
            valIdx += 1;
          } else {
            rawIdx++;
            valIdx++;
          }
        }
        if (escaped.length > 0) {
          node.data.escapedChars = escaped;
        }
      }

      if (raw.endsWith('\\') && value.endsWith('\\')) {
        node.data.sourceRaw = raw;
      }
      break;
    }

    case 'emphasis': {
      const ch = source[startOff];
      if (ch === '*' || ch === '_') {
        node.data.sourceDelimiter = ch;
      }
      break;
    }

    case 'strong': {
      const s = source.slice(startOff, startOff + 2);
      if (s === '**' || s === '__') {
        node.data.sourceDelimiter = s;
      }
      break;
    }

    case 'heading': {
      const prefix = source[startOff];
      const segment = source.slice(startOff, endOff);
      if (prefix === '#') {
        node.data.sourceStyle = 'atx';
        if (parent?.type === 'root') {
          let lineStart = startOff;
          while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
          const indentSlice = source.slice(lineStart, startOff);
          if (indentSlice.length >= 1 && indentSlice.length <= 3 && /^ +$/.test(indentSlice)) {
            node.data.sourceLeadingIndent = indentSlice.length;
          }
        }
        const interior = /^#+( {2,})[^ ]/.exec(segment);
        if (interior) {
          node.data.sourceInteriorSpacing = interior[1].length;
        }
        const trailing = /^.*?[ \t](#+)[ \t]*$/.exec(segment);
        if (trailing) {
          node.data.sourceTrailingHashes = trailing[1].length;
        }
      } else {
        const setextH1 = /\n(=+)[ \t]*$/.exec(segment);
        const setextH2 = /\n(-+)[ \t]*$/.exec(segment);
        const setextMatch = setextH1 ?? setextH2;
        if (setextMatch) {
          node.data.sourceStyle = 'setext';
          node.data.sourceUnderlineLength = setextMatch[1].length;
        } else {
          node.data.sourceStyle = 'atx';
        }
      }
      break;
    }

    case 'blockquote': {
      let lineStart = startOff;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      let isNested = false;
      for (let i = lineStart; i < startOff; i++) {
        if (source[i] === '>') {
          isNested = true;
          break;
        }
      }

      const slice = source.slice(startOff, endOff);
      const lines = slice.split('\n');
      const markerSpacings: Array<number | 'lazy'> = [];
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (line.trim().length === 0) continue;
        if (isNested && lineIdx > 0) break;
        const stripped = line.replace(/^ {1,3}/, '');
        if (stripped[0] !== '>') {
          if (lineIdx > 0 && line.trimStart()[0] !== '>') markerSpacings.push('lazy');
          continue;
        }
        const restAfterMarker = stripped.slice(1).trimEnd();
        if (restAfterMarker === '') continue;
        if (stripped[1] === '\t') {
          markerSpacings.push(1);
        } else {
          let spaceRun = 0;
          while (stripped[1 + spaceRun] === ' ') spaceRun++;
          markerSpacings.push(spaceRun);
        }
      }
      if (markerSpacings.length > 0) {
        node.data.sourceMarkerSpacings = markerSpacings;
      }
      break;
    }

    case 'list': {
      const firstItem = node.children?.[0];
      if (firstItem?.position?.start?.offset != null) {
        const itemStart = firstItem.position.start.offset;
        if (itemStart >= 0 && itemStart < source.length) {
          const ch = source[itemStart];
          if (!node.ordered && (ch === '-' || ch === '*' || ch === '+')) {
            node.data.bulletMarker = ch;
          } else if (node.ordered) {
            const tail = source.slice(itemStart, Math.min(itemStart + 10, source.length));
            const m = tail.match(/^\d+([.)])/);
            if (m) node.data.listMarkerDelimiter = m[1];
          }
        }
      }
      break;
    }

    case 'listItem': {
      const slice = source.slice(startOff, endOff);
      const m = /^(?:([-+*])|(\d{1,9})[.)])( *)/.exec(slice);
      if (!m) break;
      const markerLen = m[1] ? 1 : (m[2]?.length ?? 0) + 1;
      const spacing = m[3].length;
      if (spacing >= 2 && spacing <= 4) {
        node.data.sourceMarkerSpacing = spacing;
      }
      if (m[2]) {
        node.data.sourceOrdinal = Number.parseInt(m[2], 10);
      }
      if (node.checked != null) {
        const checkbox = /^\[([xX])\] /.exec(slice.slice(markerLen + Math.max(spacing, 1)));
        if (checkbox?.[1] === 'X') {
          node.data.sourceCheckboxChar = 'X';
        }
      }
      const effectiveSpacing = spacing >= 2 && spacing <= 4 ? spacing : 1;
      const contentCol = markerLen + effectiveSpacing;
      let itemLineStart = startOff;
      while (itemLineStart > 0 && source[itemLineStart - 1] !== '\n') itemLineStart--;
      const itemCol = pos.start.column;
      for (const child of node.children ?? []) {
        if (child.type !== 'list') continue;
        const childStart = child.position?.start?.offset;
        const childCol = child.position?.start?.column;
        if (typeof childStart !== 'number' || typeof childCol !== 'number') continue;
        let childLineStart = childStart;
        while (childLineStart > 0 && source[childLineStart - 1] !== '\n') childLineStart--;
        if (childLineStart === itemLineStart) continue;
        const indent = childCol - itemCol;
        if (
          indent !== contentCol &&
          indent >= contentCol &&
          indent <= contentCol + 3 &&
          /^ +$/.test(source.slice(childLineStart, childStart))
        ) {
          node.data.sourceContinuationIndent = indent;
        }
        break;
      }
      break;
    }

    case 'delete': {
      if (source[startOff] === '~') {
        node.data.sourceDelimiter = source[startOff + 1] === '~' ? '~~' : '~';
      }
      break;
    }

    case 'code': {
      const ch = source[startOff];
      if (ch === '`' || ch === '~') {
        node.data.sourceStyle = 'fenced';
        node.data.sourceFenceChar = ch;
        let count = 0;
        while (startOff + count < source.length && source[startOff + count] === ch) {
          count++;
        }
        if (count >= 3) {
          node.data.sourceFenceLength = count;
        }

        if (parent?.type === 'root') {
          let fenceLineStart = startOff;
          while (fenceLineStart > 0 && source[fenceLineStart - 1] !== '\n') fenceLineStart--;
          const fenceIndent = source.slice(fenceLineStart, startOff);
          if (fenceIndent.length >= 1 && fenceIndent.length <= 3 && /^ +$/.test(fenceIndent)) {
            node.data.sourceFenceIndent = fenceIndent.length;
          }
        }

        if (node.lang) {
          let gap = 0;
          while (source[startOff + count + gap] === ' ') gap++;
          if (gap >= 1) {
            node.data.sourceInfoPadding = gap;
          }
        }

        const fenceSlice = source.slice(startOff, endOff);
        const closing = new RegExp(`\\n[ \\t]*(\\${ch}+)[ \\t]*$`).exec(fenceSlice);
        if (closing && closing[1].length > count) {
          node.data.sourceClosingFenceLength = closing[1].length;
        }

        if (parent?.type === 'root') {
          const closerRe = new RegExp(`\\n {0,3}\\${ch}{${count},}[ \\t]*$`);
          if (!closerRe.test(fenceSlice)) {
            node.data.sourceUnclosedFence = true;
          }
        }
      } else {
        node.data.sourceStyle = 'indented';
        if (parent?.type === 'root') {
          const sliceLines = source.slice(startOff, endOff).split('\n');
          const valueLines = (node.value ?? '').split('\n');
          if (sliceLines.length === valueLines.length) {
            const indents: string[] = [];
            let nonCanonical = false;
            let valid = true;
            for (let i = 0; i < sliceLines.length; i++) {
              const sliceLine = sliceLines[i];
              const valueLine = valueLines[i];
              if (!sliceLine.endsWith(valueLine)) {
                valid = false;
                break;
              }
              const indent = sliceLine.slice(0, sliceLine.length - valueLine.length);
              if (!/^[ \t]*$/.test(indent)) {
                valid = false;
                break;
              }
              indents.push(indent);
              if (indent !== (valueLine.length > 0 ? '    ' : '')) nonCanonical = true;
            }
            if (valid && nonCanonical) {
              node.data.sourceIndents = indents;
            }
          }
        }
      }
      break;
    }

    case 'inlineCode': {
      const ch = source[startOff];
      if (ch === '`' || ch === '~') {
        node.data.sourceFenceChar = ch;
        let count = 0;
        while (startOff + count < source.length && source[startOff + count] === ch) {
          count++;
        }
        if (count >= 1) {
          node.data.sourceFenceLength = count;
        }
        const inner = source.slice(startOff + count, endOff - count);
        const value: string = node.value ?? '';
        if (inner !== value && inner === ` ${value} `) {
          node.data.sourcePadded = true;
        }
      }
      break;
    }

    case 'inlineMath': {
      if (source[startOff] === '$') {
        let count = 0;
        while (startOff + count < source.length && source[startOff + count] === '$') {
          count++;
        }
        node.data.sourceDelimiter = '$'.repeat(count);
      }
      break;
    }

    case 'thematicBreak': {
      node.data.sourceRaw = source.slice(startOff, endOff);
      break;
    }

    case 'table': {
      const tableSrc = source.slice(startOff, endOff);
      const newlineIdx = tableSrc.indexOf('\n');
      if (newlineIdx === -1) break;
      const afterHeader = tableSrc.slice(newlineIdx + 1);
      const nextNewlineIdx = afterHeader.indexOf('\n');
      const alignmentLine =
        nextNewlineIdx === -1 ? afterHeader : afterHeader.slice(0, nextNewlineIdx);

      const inner = alignmentLine.trim().replace(/^\|/, '').replace(/\|$/, '');
      const cells = inner.split('|');
      const dashCounts: number[] = [];
      for (const cell of cells) {
        const matches = cell.match(/-/g);
        dashCounts.push(matches ? matches.length : 0);
      }
      if (dashCounts.some((c) => c > 0)) {
        node.data.sourceDashCounts = dashCounts;
      }

      {
        const trimmedAlign = alignmentLine.trim();
        const segments = splitGfmCellSegments(trimmedAlign);
        if (segments.length > 0 && segments[0] === '' && trimmedAlign.startsWith('|')) {
          segments.shift();
        }
        if (
          segments.length > 0 &&
          segments[segments.length - 1] === '' &&
          trimmedAlign.endsWith('|')
        ) {
          segments.pop();
        }
        const allDelimiterCells = segments.every((seg) => /^[-: ]+$/.test(seg));
        const alignPadding: Array<{ left: number; right: number }> = [];
        for (const seg of segments) {
          let left = 0;
          while (left < seg.length && seg[left] === ' ') left++;
          let right = 0;
          while (right < seg.length - left && seg[seg.length - 1 - right] === ' ') right++;
          alignPadding.push({ left, right });
        }
        if (allDelimiterCells && alignPadding.length > 0) {
          node.data.sourceAlignmentPadding = alignPadding;
        }
      }

      {
        const tableLines = tableSrc.split('\n').filter((l) => l.trim().length > 0);
        if (tableLines.length >= 2) {
          const leadingStates = tableLines.map((l) => l.trimStart().startsWith('|'));
          const trailingStates = tableLines.map((l) => /(^|[^\\])\|$/.test(l.trimEnd()));
          const uniformLeading = leadingStates.every((s) => s === leadingStates[0]);
          const uniformTrailing = trailingStates.every((s) => s === trailingStates[0]);
          if (uniformLeading && uniformTrailing) {
            const leading = leadingStates[0];
            const trailing = trailingStates[0];
            if (!leading || !trailing) {
              node.data.sourceOuterPipes = { leading, trailing };
            }
          }
        }
      }

      for (const row of node.children ?? []) {
        if (row.type !== 'tableRow' || !row.position) continue;
        const rowStart = row.position.start.offset;
        const rowEnd = row.position.end.offset;
        if (typeof rowStart !== 'number' || typeof rowEnd !== 'number') continue;
        let rowSrc = source.slice(rowStart, rowEnd);
        const lineBreak = rowSrc.indexOf('\n');
        if (lineBreak !== -1) rowSrc = rowSrc.slice(0, lineBreak);

        const segments = splitGfmCellSegments(rowSrc);
        if (segments.length > 0 && segments[0] === '' && rowSrc.startsWith('|')) {
          segments.shift();
        }
        if (segments.length > 0 && segments[segments.length - 1] === '' && rowSrc.endsWith('|')) {
          segments.pop();
        }

        const rowCells = row.children ?? [];
        const limit = Math.min(rowCells.length, segments.length);
        for (let i = 0; i < limit; i++) {
          const cell = rowCells[i];
          if (cell.type !== 'tableCell') continue;
          const seg = segments[i];
          let leftPad = 0;
          while (leftPad < seg.length && seg[leftPad] === ' ') leftPad++;
          let rightPad = 0;
          while (rightPad < seg.length - leftPad && seg[seg.length - 1 - rightPad] === ' ') {
            rightPad++;
          }
          cell.data ||= {};
          cell.data.sourcePadding = { left: leftPad, right: rightPad };
        }
      }
      break;
    }

    case 'link':
    case 'linkReference': {
      if ('children' in node && node.children.length === 0) {
        node.data.sourceRaw = source.slice(startOff, endOff);
      }
      if (node.type === 'link') {
        const first = source[startOff];
        if (first !== '[' && first !== '<' && !node.title) {
          node.data.sourceStyle = 'gfm-autolink';
        } else if (first === '[') {
          const slice = source.slice(startOff, endOff);
          const closeBracketIdx = slice.lastIndexOf('](');
          if (closeBracketIdx !== -1) {
            let cursor = closeBracketIdx + 2;
            while (cursor < slice.length && (slice[cursor] === ' ' || slice[cursor] === '\t')) {
              cursor++;
            }
            if (opensEnclosedDestination(slice, cursor, node.data)) {
              node.data.sourceUrlForm = 'angle-bracketed';
            }
            if (
              node.title !== undefined &&
              node.title !== null &&
              slice[slice.length - 1] === ')'
            ) {
              let i = slice.length - 2;
              while (
                i > closeBracketIdx + 1 &&
                (slice[i] === ' ' || slice[i] === '\t' || slice[i] === '\n')
              ) {
                i--;
              }
              if (slice[i] === '"') {
                node.data.sourceTitleMarker = 'double';
              } else if (slice[i] === "'") {
                node.data.sourceTitleMarker = 'single';
              } else if (slice[i] === ')') {
                node.data.sourceTitleMarker = 'paren';
              }
            }
          }
        }
      }
      break;
    }

    case 'image': {
      const slice = source.slice(startOff, endOff);
      const closeBracketIdx = slice.lastIndexOf('](');
      if (
        closeBracketIdx !== -1 &&
        destinationStartsWithAngle(slice, closeBracketIdx + 2, node.data)
      ) {
        node.data.sourceUrlForm = 'angle-bracketed';
      }
      break;
    }

    case 'definition': {
      const slice = source.slice(startOff, endOff);
      node.data.sourceLayout = slice.includes('\n') ? 'multiline' : 'inline';
      const labelCloseIdx = definitionLabelCloseIndex(slice);
      if (labelCloseIdx !== -1 && destinationStartsWithAngle(slice, labelCloseIdx + 2, node.data)) {
        node.data.sourceUrlForm = 'angle-bracketed';
      }
      if (typeof node.title === 'string' && slice.length > 0) {
        const lastChar = slice[slice.length - 1];
        if (lastChar === '"') {
          node.data.sourceTitleMarker = 'double';
        } else if (lastChar === "'") {
          node.data.sourceTitleMarker = 'single';
        } else if (lastChar === ')') {
          node.data.sourceTitleMarker = 'paren';
        }
      }
      break;
    }

    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
    case 'mdxFlowExpression':
    case 'mdxTextExpression': {
      node.data.sourceRaw = source.slice(startOff, endOff);
      break;
    }

    case 'break': {
      if (node.data.sourceRaw) break;
      const slice = source.slice(startOff, endOff);
      if (slice.includes('\\')) {
        node.data.sourceStyle = 'backslash';
      } else {
        node.data.sourceStyle = 'spaces';
      }
      break;
    }
  }
}

interface DestinationSourceData {
  sourceGuardedDestinationOpen?: true;
}

function destinationStartsWithAngle(
  slice: string,
  from: number,
  data: DestinationSourceData,
): boolean {
  let cursor = from;
  while (cursor < slice.length && /[ \t\r\n]/.test(slice[cursor])) cursor++;
  return opensEnclosedDestination(slice, cursor, data);
}

function opensEnclosedDestination(
  slice: string,
  cursor: number,
  data: DestinationSourceData,
): boolean {
  return slice[cursor] === '<' && data.sourceGuardedDestinationOpen !== true;
}

function definitionLabelCloseIndex(slice: string): number {
  for (let i = 1; i < slice.length; i++) {
    const ch = slice[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === ']') return slice[i + 1] === ':' ? i : -1;
  }
  return -1;
}

type RawSourceMdxNode =
  | MdxJsxFlowElement
  | MdxJsxTextElement
  | MdxFlowExpression
  | MdxTextExpression;

type LinePrefixContainer = Blockquote | ListItem | FootnoteDefinition;

interface PrefixConsumption {
  offset: number;
  complete: boolean;
}

interface LineContent extends PrefixConsumption {
  contentStart: number;
}

const RAW_SOURCE_MDX_TYPES: ReadonlySet<string> = new Set([
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
  'mdxFlowExpression',
  'mdxTextExpression',
]);

const LIST_MARKER_RE = /^(?:[-+*]|\d{1,9}[.)])/;

const FOOTNOTE_CONTINUATION_WIDTH = 4;

interface PrefixScan {
  readonly source: string;
  readonly lineStarts: readonly number[];
  readonly widths: Map<LinePrefixContainer, number | null>;
  readonly contentOffsets: Map<LinePrefixContainer, number | null>;
}

function isRawSourceMdxNode(node: Nodes): node is RawSourceMdxNode {
  return RAW_SOURCE_MDX_TYPES.has(node.type);
}

function isLinePrefixContainer(node: Nodes): node is LinePrefixContainer {
  return (
    node.type === 'blockquote' || node.type === 'listItem' || node.type === 'footnoteDefinition'
  );
}

export function needsNestedRawRelativization(
  node: Nodes,
  parent: { type?: string } | undefined,
): boolean {
  if (parent === undefined || parent.type === 'root' || !isRawSourceMdxNode(node)) return false;
  if (node.type === 'mdxJsxFlowElement' && parent.type === 'mdxJsxFlowElement') return true;
  const raw = node.data?.sourceRaw;
  return typeof raw === 'string' && raw.includes('\n');
}

function createPrefixScan(source: string): PrefixScan {
  const lineStarts = [0];
  for (
    let newline = source.indexOf('\n');
    newline !== -1;
    newline = source.indexOf('\n', newline + 1)
  ) {
    lineStarts.push(newline + 1);
  }
  return { source, lineStarts, widths: new Map(), contentOffsets: new Map() };
}

function lineStartOf(scan: PrefixScan, offset: number): number {
  const { lineStarts } = scan;
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return lineStarts[low];
}

function isBlankFrom(source: string, offset: number): boolean {
  let cursor = offset;
  while (source[cursor] === ' ' || source[cursor] === '\t' || source[cursor] === '\r') cursor++;
  return cursor >= source.length || source[cursor] === '\n';
}

function isSpaceRun(source: string, from: number, to: number): boolean {
  for (let cursor = from; cursor < to; cursor++) {
    if (source[cursor] !== ' ') return false;
  }
  return true;
}

function findFirstLineContentOffset(
  container: ListItem | FootnoteDefinition,
  source: string,
  start: number,
): number | null {
  if (container.type === 'footnoteDefinition') {
    const label = /\[\^[^\]\n]*\]:[ \t]*/y;
    label.lastIndex = start;
    const match = label.exec(source);
    return match ? start + match[0].length : null;
  }
  const marker = LIST_MARKER_RE.exec(source.slice(start, start + 11));
  if (!marker) return null;
  let cursor = start + marker[0].length;
  while (source[cursor] === ' ') cursor++;
  return cursor;
}

function firstLineContentOffset(
  scan: PrefixScan,
  container: ListItem | FootnoteDefinition,
  start: number,
): number | null {
  const memo = scan.contentOffsets.get(container);
  if (memo !== undefined) return memo;
  const offset = findFirstLineContentOffset(container, scan.source, start);
  scan.contentOffsets.set(container, offset);
  return offset;
}

function containerWidth(
  scan: PrefixScan,
  containers: readonly LinePrefixContainer[],
  index: number,
): number | null {
  const container = containers[index];
  const memo = scan.widths.get(container);
  if (memo !== undefined) return memo;
  let width: number | null = null;
  if (container.type === 'footnoteDefinition') {
    width = FOOTNOTE_CONTINUATION_WIDTH;
  } else if (container.type === 'listItem') {
    width = listItemWidth(scan, container, containers.slice(0, index));
  }
  scan.widths.set(container, width);
  return width;
}

function listItemWidth(
  scan: PrefixScan,
  item: ListItem,
  outer: readonly LinePrefixContainer[],
): number | null {
  const { source } = scan;
  const start = item.position?.start?.offset;
  if (typeof start !== 'number') return null;
  const before = consumeLinePrefixes(scan, lineStartOf(scan, start), outer);
  if (!before.complete || before.offset > start) return null;
  if (!isSpaceRun(source, before.offset, start)) return null;
  const marker = LIST_MARKER_RE.exec(source.slice(start, start + 11));
  if (!marker) return null;
  const afterMarker = start + marker[0].length;
  let spaces = 0;
  while (source[afterMarker + spaces] === ' ') spaces++;
  if (source[afterMarker + spaces] === '\t') return null;
  const contentGap = isBlankFrom(source, afterMarker) ? 1 : spaces;
  return start - before.offset + marker[0].length + contentGap;
}

function consumeLinePrefix(
  scan: PrefixScan,
  offset: number,
  lineStart: number,
  containers: readonly LinePrefixContainer[],
  index: number,
): number | null {
  const { source } = scan;
  const container = containers[index];
  if (container.type === 'blockquote') {
    let cursor = offset;
    while (source[cursor] === ' ') cursor++;
    if (source[cursor] !== '>') return null;
    cursor++;
    if (source[cursor] === ' ' || source[cursor] === '\t') cursor++;
    return cursor;
  }
  const start = container.position?.start?.offset;
  if (typeof start !== 'number') return null;
  if (start >= lineStart) return firstLineContentOffset(scan, container, start);
  const width = containerWidth(scan, containers, index);
  if (width === null) return null;
  let cursor = offset;
  while (cursor < offset + width && source[cursor] === ' ') cursor++;
  if (cursor === offset + width) return cursor;
  return isBlankFrom(source, cursor) ? cursor : null;
}

function consumeLinePrefixes(
  scan: PrefixScan,
  lineStart: number,
  containers: readonly LinePrefixContainer[],
): PrefixConsumption {
  let offset = lineStart;
  for (let index = 0; index < containers.length; index++) {
    const next = consumeLinePrefix(scan, offset, lineStart, containers, index);
    if (next === null) return { offset, complete: false };
    offset = next;
  }
  return { offset, complete: true };
}

function relativizeNestedRaw(
  node: RawSourceMdxNode,
  parent: Nodes,
  scan: PrefixScan,
  consumeLine: (lineStart: number) => LineContent,
): void {
  const { source } = scan;
  const raw = node.data?.sourceRaw;
  const start = node.position?.start?.offset;
  if (typeof raw !== 'string' || typeof start !== 'number') return;
  if (source.slice(start, start + raw.length) !== raw) return;
  const lines = raw.split('\n');
  let lineStart = start + lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const consumed = consumeLine(lineStart);
    lines[i] = line.slice(Math.min(consumed.offset - lineStart, line.length));
    lineStart += line.length + 1;
  }
  let leadingIndent = '';
  if (node.type === 'mdxJsxFlowElement' && parent.type === 'mdxJsxFlowElement') {
    const content = consumeLine(lineStartOf(scan, start));
    if (content.complete && content.contentStart === start) {
      leadingIndent = source.slice(content.offset, start);
    }
  }
  const relativized = leadingIndent + lines.join('\n');
  if (relativized !== raw) node.data = { ...node.data, sourceRaw: relativized };
}

export function relativizeNestedMdxSourceRaw(tree: Root, source: string): void {
  const scan = createPrefixScan(source);
  const containers: LinePrefixContainer[] = [];
  let lineContents = new Map<number, LineContent>();
  const consumeLine = (lineStart: number): LineContent => {
    let content = lineContents.get(lineStart);
    if (content === undefined) {
      const consumed = consumeLinePrefixes(scan, lineStart, containers);
      let contentStart = consumed.offset;
      while (source[contentStart] === ' ') contentStart++;
      content = { ...consumed, contentStart };
      lineContents.set(lineStart, content);
    }
    return content;
  };
  const walk = (node: Nodes, parent: Nodes): void => {
    if (parent.type !== 'root' && isRawSourceMdxNode(node)) {
      relativizeNestedRaw(node, parent, scan, consumeLine);
    }
    if (!('children' in node)) return;
    const isContainer = isLinePrefixContainer(node);
    if (isContainer) {
      containers.push(node);
      lineContents = new Map();
    }
    for (const child of node.children) walk(child as Nodes, node);
    if (isContainer) {
      containers.pop();
      lineContents = new Map();
    }
  };
  for (const child of tree.children) walk(child, tree);
}

export function positionSlicePlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    if (!source) return;

    const debug = typeof process !== 'undefined' && process.env?.OK_DEBUG_POSITION_SLICE === '1';

    let sawNestedRawSourceMdx = false;
    visit(tree, (node: Nodes, _index, parent) => {
      applyPositionSliceToNode(node, source, debug, parent ?? undefined);
      if (needsNestedRawRelativization(node, parent ?? undefined)) sawNestedRawSourceMdx = true;
    });
    if (sawNestedRawSourceMdx) relativizeNestedMdxSourceRaw(tree, source);
  };
}
