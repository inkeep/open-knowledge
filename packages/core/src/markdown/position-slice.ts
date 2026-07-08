
import type { Nodes, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';

const ESCAPABLE_CHARS = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

interface EscapedChar {
  offset: number;
  char: string;
}

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
      if (raw.length > value.length && raw.includes('\\')) {
        const escaped: EscapedChar[] = [];
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
            rawIdx += 2; // skip backslash + char
            valIdx += 1; // the char appears in value without backslash
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
      const markerSpacings: number[] = [];
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (line.length === 0) continue;
        if (isNested && lineIdx > 0) break;
        const stripped = line.replace(/^ {1,3}/, '');
        if (stripped[0] !== '>') continue;
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
        if (childLineStart === itemLineStart) continue; // same-line list — no pad applies
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
        }
        else if (first === '[') {
          const slice = source.slice(startOff, endOff);
          const closeBracketIdx = slice.lastIndexOf('](');
          if (closeBracketIdx !== -1) {
            let cursor = closeBracketIdx + 2;
            while (cursor < slice.length && (slice[cursor] === ' ' || slice[cursor] === '\t')) {
              cursor++;
            }
            if (slice[cursor] === '<') {
              node.data.sourceUrlForm = 'angle-bracketed';
            }
            if (
              node.title !== undefined &&
              node.title !== null &&
              slice[slice.length - 1] === ')'
            ) {
              let i = slice.length - 2; // skip the link's closing `)`
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

    case 'definition': {
      const slice = source.slice(startOff, endOff);
      node.data.sourceLayout = slice.includes('\n') ? 'multiline' : 'inline';
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

export function positionSlicePlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    if (!source) return;

    const debug = typeof process !== 'undefined' && process.env?.OK_DEBUG_POSITION_SLICE === '1';

    visit(tree, (node: Nodes, _index, parent) => {
      applyPositionSliceToNode(node, source, debug, parent ?? undefined);
    });
  };
}
