
import type { Nodes, Parents } from 'mdast';
import type { MdxJsxAttribute, MdxJsxExpressionAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import type { Handle, Info, State } from 'mdast-util-to-markdown';
import { classifyCharacter } from 'micromark-util-classify-character';
import { isValidSourceLiteralRaw } from '../extensions/source-literal-mark.ts';
import { TO_MARKDOWN_EXT } from './remark-mdx-agnostic.ts';

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap {
    mark: 'mark';
    comment: 'comment';
    commentBlock: 'commentBlock';
    strikethrough: 'strikethrough';
  }
}

type MdastToMarkdownHandlerFor<N extends Nodes['type']> = (
  node: Extract<Nodes, { type: N }>,
  parent: Parents | undefined,
  state: State,
  info: Info,
) => string;

type MdastToMarkdownHandlers = {
  [K in Nodes['type']]: MdastToMarkdownHandlerFor<K>;
} & {
  mdxJsxFlowElement: (node: Nodes, parent: Parents | undefined, state: State, info: Info) => string;
};

const inlineMathHandler = Object.assign(serializeInlineMath, { peek: () => '$' });

const deleteHandler = Object.assign(serializeDelete, { peek: () => '~' });

const upstreamMdxJsxFlowHandler: Handle = (() => {
  for (const ext of TO_MARKDOWN_EXT.extensions ?? []) {
    const handler = ext?.handlers?.mdxJsxFlowElement;
    if (typeof handler === 'function') return handler;
  }
  throw new Error(
    'mdast-util-mdx-jsx mdxJsxFlowElement to-markdown handler not found — the ' +
      'dirty MDX JSX serialize path cannot bind. Likely a breaking change in ' +
      'mdast-util-mdx-jsx (pinned in the root overrides); re-run the ' +
      'markdown-pipeline upgrade protocol (test:fidelity).',
  );
})();

export const toMarkdownHandlers = {
  text(node, _parent, state, info) {
    if (typeof node.data?.sourceRaw === 'string') {
      if (isValidSourceLiteralRaw(node.data.sourceRaw, node.value ?? '')) {
        return node.data.sourceRaw;
      }
    }

    if (node.data?.escapedChars?.length) {
      const value: string = node.value ?? '';
      const escaped: Array<{ offset: number; char: string }> = node.data.escapedChars;
      let result = '';
      let lastIdx = 0;
      for (const { offset, char } of escaped) {
        if (offset > lastIdx) {
          result += safeText(state, value.slice(lastIdx, offset), {
            ...info,
            before: info.before + result,
            after: '\\',
          });
        }
        result += `\\${char}`;
        lastIdx = offset + 1;
      }
      if (lastIdx < value.length) {
        result += safeText(state, value.slice(lastIdx), {
          ...info,
          before: info.before + result,
        });
      }
      return result;
    }

    return safeText(state, (node.value ?? '').replaceAll('\u00A0', ' '), info);
  },

  emphasis(node, _parent, state, info) {
    const delim = node.data?.sourceDelimiter ?? '*';
    const tracker = state.createTracker(info);
    const exit = state.enter('emphasis');
    let value = tracker.move(delim);
    value += encodeAttentionBoundaries(
      state.containerPhrasing(node, {
        before: value,
        after: delim,
        ...tracker.current(),
      }),
      info,
      delim,
    );
    value += tracker.move(delim);
    exit();
    return value;
  },

  strong(node, _parent, state, info) {
    const delim = node.data?.sourceDelimiter ?? '**';
    const tracker = state.createTracker(info);
    const exit = state.enter('strong');
    let value = tracker.move(delim);
    value += encodeAttentionBoundaries(
      state.containerPhrasing(node, {
        before: value,
        after: delim,
        ...tracker.current(),
      }),
      info,
      delim,
    );
    value += tracker.move(delim);
    exit();
    return value;
  },

  link(node, _parent, state, info) {
    if (node.data?.sourceStyle === 'autolink') {
      return `<${node.url ?? ''}>`;
    }
    if (node.data?.sourceStyle === 'gfm-autolink') {
      const onlyChild = node.children?.length === 1 ? node.children[0] : null;
      if (onlyChild?.type === 'text' && typeof onlyChild.value === 'string') {
        return onlyChild.value;
      }
    }
    const tracker = state.createTracker(info);
    const exit = state.enter('link');
    const subexit = state.enter('label');
    let value = tracker.move('[');
    value += tracker.move(
      state.containerPhrasing(node, {
        before: value,
        after: '](',
        ...tracker.current(),
      }),
    );
    value += tracker.move('](');
    subexit();

    const urlExit = state.enter('destinationRaw');
    const urlRaw = String(node.url ?? '');
    const wantAngles = node.data?.sourceUrlForm === 'angle-bracketed';
    const alreadyAngled = urlRaw.startsWith('<') && urlRaw.endsWith('>');
    const urlOut = wantAngles && !alreadyAngled ? `<${urlRaw}>` : formatLinkUrl(urlRaw);
    value += tracker.move(urlOut);
    urlExit();

    if (node.title) {
      const marker = node.data?.sourceTitleMarker ?? 'double';
      value += tracker.move(emitLinkTitle(node.title, marker));
    }
    value += tracker.move(')');
    exit();
    return value;
  },

  image(node, _parent, state, info) {
    const tracker = state.createTracker(info);
    const exit = state.enter('image');
    const subexit = state.enter('label');
    let value = tracker.move('![');
    value += tracker.move(
      state.safe(node.alt ?? '', {
        before: value,
        after: '](',
        ...tracker.current(),
      }),
    );
    value += tracker.move('](');
    subexit();

    const urlExit = state.enter('destinationRaw');
    value += tracker.move(formatLinkUrl(String(node.url ?? '')));
    urlExit();

    if (node.title) {
      const titleExit = state.enter('titleQuote');
      value += tracker.move(' "');
      value += tracker.move(
        state.safe(node.title, { before: value, after: '"', ...tracker.current() }),
      );
      value += tracker.move('"');
      titleExit();
    }
    value += tracker.move(')');
    exit();
    return value;
  },

  definition(node, _parent, state, info) {
    const layout = node.data?.sourceLayout ?? 'inline';
    const marker = node.data?.sourceTitleMarker ?? 'double';

    const exit = state.enter('definition');
    const tracker = state.createTracker(info);

    const labelExit = state.enter('label');
    let value = tracker.move('[');
    value += tracker.move(
      state.safe(state.associationId(node), {
        before: value,
        after: ']',
        ...tracker.current(),
      }),
    );
    value += tracker.move(']:');
    labelExit();

    const sep1 = layout === 'multiline' ? '\n  ' : ' ';
    value += tracker.move(sep1);

    const urlRaw = String(node.url ?? '');
    if (!urlRaw || /[\0- ]/.test(urlRaw)) {
      const destExit = state.enter('destinationLiteral');
      value += tracker.move('<');
      value += tracker.move(
        state.safe(urlRaw, { before: value, after: '>', ...tracker.current() }),
      );
      value += tracker.move('>');
      destExit();
    } else {
      const destExit = state.enter('destinationRaw');
      value += tracker.move(formatLinkUrl(urlRaw));
      destExit();
    }

    if (node.title) {
      const titleSep = layout === 'multiline' ? '\n  ' : ' ';
      value += tracker.move(emitLinkTitle(node.title, marker, titleSep));
    }

    exit();
    return value;
  },

  thematicBreak(node) {
    return node.data?.sourceRaw ?? '---';
  },

  break(node) {
    if (node.data?.sourceStyle === 'backslash') return '\\\n';
    return '  \n';
  },

  code(node) {
    const value = node.value ?? '';
    if (node.data?.sourceStyle === 'indented') {
      const lines = value.split('\n');
      const indents = node.data.sourceIndents;
      if (Array.isArray(indents) && indents.length === lines.length) {
        return lines
          .map((line, i) => `${indents[i] ?? (line.length > 0 ? '    ' : '')}${line}`)
          .join('\n');
      }
      const indented = lines.map((line) => (line.length > 0 ? `    ${line}` : line)).join('\n');
      return indented;
    }
    const fenceChar = node.data?.sourceFenceChar;
    const char = fenceChar === '~' ? '~' : '`';
    let len = Math.max(3, node.data?.sourceFenceLength ?? 3);
    const fenceRunRe = new RegExp(`^ {0,3}(\\${char}+)[ \\t]*$`);
    for (const line of value.split('\n')) {
      const run = fenceRunRe.exec(line);
      if (run && run[1].length >= len) {
        len = run[1].length + 1;
      }
    }
    const closingCaptured = node.data?.sourceClosingFenceLength;
    const closeLen =
      typeof closingCaptured === 'number' && closingCaptured > len ? closingCaptured : len;
    const indentCount = node.data?.sourceFenceIndent;
    const indent =
      typeof indentCount === 'number' && indentCount >= 1 && indentCount <= 3
        ? ' '.repeat(indentCount)
        : '';
    const infoGap = node.data?.sourceInfoPadding;
    const fence = char.repeat(len);
    const lang = node.lang ?? '';
    const langGap = lang && typeof infoGap === 'number' && infoGap >= 1 ? ' '.repeat(infoGap) : '';
    const meta = node.meta ? ` ${node.meta}` : '';
    const body = `${fence}${langGap}${lang}${meta}\n${value}\n${char.repeat(closeLen)}`;
    if (!indent) return body;
    return body
      .split('\n')
      .map((l) => (l.length > 0 ? `${indent}${l}` : l))
      .join('\n');
  },

  inlineCode(node, _parent, state) {
    let value = node.value ?? '';
    const requestedChar = node.data?.sourceFenceChar;
    const fenceChar = requestedChar === '~' ? '~' : '`';
    const requestedLen =
      typeof node.data?.sourceFenceLength === 'number' && node.data.sourceFenceLength > 0
        ? node.data.sourceFenceLength
        : 1;

    const escaped = fenceChar === '`' ? '`' : '~';
    let length = requestedLen;
    while (new RegExp(`(^|[^${escaped}])${escaped.repeat(length)}([^${escaped}]|$)`).test(value)) {
      length += 1;
    }
    const fence = fenceChar.repeat(length);

    if (
      /[^ \r\n]/.test(value) &&
      (node.data?.sourcePadded === true ||
        (/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) ||
        value.startsWith(fenceChar) ||
        value.endsWith(fenceChar))
    ) {
      value = ` ${value} `;
    }

    const span = `${fence}${value}${fence}`;
    return state.stack.includes('tableCell') ? span.replace(/\|/g, '\\$&') : span;
  },

  inlineMath: inlineMathHandler,

  delete: deleteHandler,

  heading(node, _parent, state, info) {
    const style = node.data?.sourceStyle ?? 'atx';
    const depth = node.depth;
    if (style === 'setext' && (depth === 1 || depth === 2)) {
      const content = state.containerPhrasing(node, { ...info, before: '\n', after: '\n' });
      const captured = node.data?.sourceUnderlineLength;
      const underlineLength =
        typeof captured === 'number' && captured >= 1 ? captured : Math.max(content.length, 3);
      const underline = (depth === 1 ? '=' : '-').repeat(underlineLength);
      return `${content}\n${underline}`;
    }
    const indentCount = node.data?.sourceLeadingIndent;
    const indent =
      typeof indentCount === 'number' && indentCount >= 1 && indentCount <= 3
        ? ' '.repeat(indentCount)
        : '';
    const interiorCount = node.data?.sourceInteriorSpacing;
    const interior =
      typeof interiorCount === 'number' && interiorCount >= 2 ? ' '.repeat(interiorCount) : ' ';
    const hashes = '#'.repeat(depth);
    const content = state.containerPhrasing(node, {
      ...info,
      before: `${hashes} `,
      after: '\n',
    });
    const trailingCount = node.data?.sourceTrailingHashes;
    if (typeof trailingCount === 'number' && trailingCount > 0) {
      const trailing = '#'.repeat(trailingCount);
      if (!content) return `${indent}${hashes} ${trailing}`;
      return `${indent}${hashes}${interior}${content} ${trailing}`;
    }
    if (!content) return `${indent}${hashes}`;
    return `${indent}${hashes}${interior}${content}`;
  },

  list(node, _parent, state, info) {
    const bullet = state.options.bullet || '-';
    const ordered = !!node.ordered;
    const savedBullet = state.bulletCurrent;
    const savedBulletLast = state.bulletLastUsed;

    if (!ordered) {
      const m = node.data?.bulletMarker;
      if (m === '-' || m === '*' || m === '+') {
        state.bulletCurrent = m;
      }
    }

    const children = node.children || [];
    const out: string[] = [];
    const delim = ordered ? (node.data?.listMarkerDelimiter ?? '.') : null;
    const counter = node.start ?? 1;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const capturedOrdinal = child.data?.sourceOrdinal;
      const ordinal =
        typeof capturedOrdinal === 'number' && capturedOrdinal >= 0 ? capturedOrdinal : counter + i;
      const baseMarker = ordered ? `${ordinal}${delim}` : (node.data?.bulletMarker ?? bullet);
      const capturedSpacing = child.data?.sourceMarkerSpacing;
      const spacing =
        typeof capturedSpacing === 'number' && capturedSpacing >= 2 && capturedSpacing <= 4
          ? capturedSpacing
          : 1;
      const markerGap = ' '.repeat(spacing);
      let marker = baseMarker;
      if (child.checked === true) {
        marker += `${markerGap}[${child.data?.sourceCheckboxChar === 'X' ? 'X' : 'x'}]`;
      } else if (child.checked === false) {
        marker += `${markerGap}[ ]`;
      }
      const capturedIndent = child.data?.sourceContinuationIndent;
      const contentCol = baseMarker.length + spacing;
      const padWidth =
        typeof capturedIndent === 'number' &&
        capturedIndent >= contentCol &&
        capturedIndent <= contentCol + 3
          ? capturedIndent
          : contentCol;
      const pad = ' '.repeat(padWidth);
      const firstGap = child.checked === null || child.checked === undefined ? markerGap : ' ';
      const itemContent = state.containerFlow(child, info);
      const indented = itemContent
        .split('\n')
        .map((l, idx) => (idx === 0 ? `${marker}${firstGap}${l}` : l ? `${pad}${l}` : l))
        .join('\n');
      out.push(indented);
    }

    state.bulletCurrent = savedBullet;
    state.bulletLastUsed = savedBulletLast;

    const sep = node.spread ? '\n\n' : '\n';
    return out.join(sep);
  },

  table(node, _parent, state, info) {
    const around = ' ';
    const tableExit = state.enter('table');

    const matrix: string[][] = [];
    const paddingMatrix: Array<Array<{ left: number; right: number } | null>> = [];
    const rows = node.children ?? [];
    for (const row of rows) {
      const cellNodes = row.children ?? [];
      const cells: string[] = [];
      const cellPaddings: Array<{ left: number; right: number } | null> = [];
      for (const cell of cellNodes) {
        const cellExit = state.enter('tableCell');
        const phrasingExit = state.enter('phrasing');
        const value = state.containerPhrasing(cell, {
          ...info,
          before: around,
          after: around,
        });
        phrasingExit();
        cellExit();
        cells.push(value);
        const pad = cell.data?.sourcePadding;
        cellPaddings.push(
          pad &&
            typeof (pad as { left?: unknown }).left === 'number' &&
            typeof (pad as { right?: unknown }).right === 'number'
            ? { left: (pad as { left: number }).left, right: (pad as { right: number }).right }
            : null,
        );
      }
      matrix.push(cells);
      paddingMatrix.push(cellPaddings);
    }
    tableExit();

    const alignArr = node.align ?? [];
    const dashCounts = node.data?.sourceDashCounts;
    const headerWidth = matrix[0]?.length ?? 0;
    const bodyWidth = matrix.slice(1).reduce((m, r) => Math.max(m, r.length), 0);
    const mostCellsPerRow = Math.max(headerWidth, bodyWidth, alignArr.length);

    const alignmentCells: string[] = [];
    for (let col = 0; col < mostCellsPerRow; col++) {
      const align = alignArr[col];
      let before = '';
      let after = '';
      if (align === 'center') {
        before = ':';
        after = ':';
      } else if (align === 'left') {
        before = ':';
      } else if (align === 'right') {
        after = ':';
      }
      const userDashCount = dashCounts?.[col];
      const dashCount = typeof userDashCount === 'number' && userDashCount >= 1 ? userDashCount : 1;
      alignmentCells.push(before + '-'.repeat(dashCount) + after);
    }

    const formatRow = (
      cells: string[],
      paddings: Array<{ left: number; right: number } | null>,
    ): string => {
      const out: string[] = [];
      for (let i = 0; i < mostCellsPerRow; i++) {
        const content = cells[i] ?? '';
        const pad = paddings[i] ?? { left: 1, right: 1 };
        out.push(' '.repeat(pad.left) + content + ' '.repeat(pad.right));
      }
      const leading = outerPipesSafe && !outerPipesSafe.leading ? '' : '|';
      const trailing = outerPipesSafe && !outerPipesSafe.trailing ? '' : '|';
      return `${leading}${out.join('|')}${trailing}`;
    };

    const capturedAlignPadding = node.data?.sourceAlignmentPadding;
    const alignmentPaddings: Array<{ left: number; right: number } | null> = Array.from(
      { length: mostCellsPerRow },
      (_, col) => {
        const pad = capturedAlignPadding?.[col];
        return pad && typeof pad.left === 'number' && typeof pad.right === 'number' ? pad : null;
      },
    );

    const outerPipes = node.data?.sourceOuterPipes;
    const outerPipesSafe =
      outerPipes &&
      mostCellsPerRow >= 2 &&
      matrix.every((cells) => {
        const first = (cells[0] ?? '').trim();
        const last = (cells[mostCellsPerRow - 1] ?? '').trim();
        return (
          (outerPipes.leading || first.length > 0) &&
          (outerPipes.trailing || (last.length > 0 && !last.endsWith('\\')))
        );
      })
        ? outerPipes
        : null;

    if (matrix.length === 0) {
      return formatRow(alignmentCells, alignmentPaddings);
    }

    const lines: string[] = [];
    lines.push(formatRow(matrix[0], paddingMatrix[0] ?? []));
    lines.push(formatRow(alignmentCells, alignmentPaddings));
    for (let i = 1; i < matrix.length; i++) {
      lines.push(formatRow(matrix[i], paddingMatrix[i] ?? []));
    }
    return lines.join('\n');
  },

  mdxJsxFlowElement(node, parent, state, info) {
    const mdxNode = node as unknown as MdxJsxFlowElement;
    const raw = mdxNode.data?.sourceRaw;
    if (typeof raw === 'string') return raw;

    const boundary = mdxNode.data?.htmlBoundary;
    if (boundary && typeof boundary.opener === 'string' && typeof boundary.closer === 'string') {
      const childContent = state.containerFlow(
        // biome-ignore lint/suspicious/noExplicitAny: safe cast for synthetic root
        { type: 'root', children: mdxNode.children ?? [] } as any,
        info,
      );
      return `${boundary.opener}\n\n${childContent}\n\n${boundary.closer}`;
    }

    const name = mdxNode.name ?? '';
    const attrs = serializeMdxJsxAttrs(mdxNode.attributes ?? []);

    if (!mdxNode.children || mdxNode.children.length === 0) {
      if (!name) return '';
      return attrs ? `<${name} ${attrs} />` : `<${name} />`;
    }

    const delegated: MdxJsxFlowElement = {
      ...mdxNode,
      attributes: (mdxNode.attributes ?? []).map(normalizeAttrForUpstream),
    };
    return upstreamMdxJsxFlowHandler(delegated, parent, state, info);
  },

  mark(node, _parent, state, info) {
    const tracker = state.createTracker(info);
    const exit = state.enter('mark');
    let value = tracker.move('==');
    value += encodeAttentionBoundaries(
      state.containerPhrasing(node as Parents, {
        before: value,
        after: '==',
        ...tracker.current(),
      }),
      info,
      '==',
    );
    value += tracker.move('==');
    exit();
    return value;
  },

  comment(node, _parent, state, info) {
    const sourceForm = node.data?.sourceForm;
    const open = sourceForm === 'html' ? '<!-- ' : '%%';
    const close = sourceForm === 'html' ? ' -->' : '%%';
    const tracker = state.createTracker(info);
    const exit = state.enter('comment');
    let value = tracker.move(open);
    value += state.containerPhrasing(node as Parents, {
      before: value,
      after: close,
      ...tracker.current(),
    });
    value += tracker.move(close);
    exit();
    return value;
  },

  commentBlock(node, _parent, state, info) {
    const tracker = state.createTracker(info);
    const exit = state.enter('commentBlock');

    const children = node.children ?? [];
    const sourceForm = node.data?.sourceForm;
    const sourceLayout = node.data?.sourceLayout;
    const isSingleParagraph = children.length === 1 && children[0]?.type === 'paragraph';

    if (sourceForm === 'html' && isSingleParagraph) {
      const para = children[0] as Parents;
      const inner = state.containerPhrasing(para, {
        before: '<!-- ',
        after: ' -->',
        ...tracker.current(),
      });
      exit();
      return `<!-- ${inner} -->`;
    }

    if (sourceLayout === 'inline' && isSingleParagraph) {
      const para = children[0] as Parents;
      const inner = state.containerPhrasing(para, {
        before: '%% ',
        after: ' %%',
        ...tracker.current(),
      });
      exit();
      return `%% ${inner} %%`;
    }

    // biome-ignore lint/suspicious/noExplicitAny: containerFlow's FlowParents type narrows to a closed set; commentBlock is a custom block-level promoted type that holds flow children, but its augmented mdast type isn't in the FlowParents union. The runtime call is correct.
    const inner = state.containerFlow(node as any, tracker.current());
    exit();
    return `%%\n\n${inner}\n\n%%`;
  },

  mdxJsxTextElement(node) {
    const raw = node.data?.sourceRaw;
    if (typeof raw === 'string') return raw;
    const name = node.name ?? '';
    const attrs = serializeMdxJsxAttrs(node.attributes ?? []);
    return attrs ? `<${name} ${attrs} />` : `<${name}/>`;
  },

  rawMdxFallback(node) {
    return (node.value ?? '') as string;
  },

  blockquote(node, _parent, state, info) {
    const exit = state.enter('blockquote');
    const tracker = state.createTracker(info);
    tracker.move('> ');
    tracker.shift(2);
    const inner = state.containerFlow(node, tracker.current());
    exit();

    const spacings = node.data?.sourceMarkerSpacings;
    let nonBlankIdx = 0;

    return state.indentLines(inner, (line, _lineNumber, blank) => {
      if (blank) return '>';
      const spacing = spacings?.[nonBlankIdx++];
      if (spacing === 'none' || spacing === 0) return `>${line}`;
      if (typeof spacing === 'number' && spacing >= 2 && !line.startsWith(' ')) {
        return `>${' '.repeat(spacing)}${line}`;
      }
      return `> ${line}`;
    });
  },
} satisfies Partial<MdastToMarkdownHandlers>;

function serializeMdxJsxAttrs(attrs: Array<MdxJsxAttribute | MdxJsxExpressionAttribute>): string {
  const parts: string[] = [];
  for (const attr of attrs) {
    if (attr.type === 'mdxJsxExpressionAttribute') {
      parts.push(`{${attr.value}}`);
      continue;
    }
    const name = attr.name;
    if (attr.value === null || attr.value === undefined) {
      parts.push(name);
      continue;
    }
    if (typeof attr.value === 'string') {
      if (attr.value.includes('"')) {
        parts.push(`${name}={${quotedAttrExpressionValue(attr.value)}}`);
      } else {
        parts.push(`${name}="${attr.value}"`);
      }
      continue;
    }
    parts.push(`${name}={${attr.value.value}}`);
  }
  return parts.join(' ');
}

function quotedAttrExpressionValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeAttrForUpstream(
  attr: MdxJsxAttribute | MdxJsxExpressionAttribute,
): MdxJsxAttribute | MdxJsxExpressionAttribute {
  if (
    attr.type === 'mdxJsxAttribute' &&
    typeof attr.value === 'string' &&
    attr.value.includes('"')
  ) {
    return {
      type: 'mdxJsxAttribute',
      name: attr.name,
      value: {
        type: 'mdxJsxAttributeValueExpression',
        value: quotedAttrExpressionValue(attr.value),
      },
    };
  }
  return attr;
}

function emitLinkTitle(
  title: string,
  marker: 'single' | 'double' | 'paren',
  separator: string = ' ',
): string {
  if (marker === 'single') {
    return `${separator}'${title.replace(/'/g, "\\'")}'`;
  }
  if (marker === 'paren') {
    return `${separator}(${title.replace(/[()]/g, '\\$&')})`;
  }
  return `${separator}"${title.replace(/"/g, '\\"')}"`;
}

export function formatLinkUrl(url: string): string {
  if (!url) return '';

  let depth = 0;
  let parensBalanced = true;
  for (const ch of url) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) parensBalanced = false;
    }
  }
  if (depth !== 0) parensBalanced = false;

  if (parensBalanced) return url;

  return url.replace(/[\\()]/g, '\\$&');
}

function escapeEntityAmpersands(s: string): string {
  return s.replace(
    /(?<!\\)&(?=(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);)/g,
    (match, body: string) => (isWhitespaceNumericCharRef(body) ? match : `\\${match}`),
  );
}

function isWhitespaceNumericCharRef(body: string): boolean {
  if (body.charCodeAt(0) !== 0x23 /* '#' */) return false;
  const code =
    body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

function safeText(state: State, value: string, info: Info): string {
  const originalUnsafe = state.unsafe;
  state.unsafe = originalUnsafe.filter((u) => {
    if (u.character === '&' && u.after === '[#A-Za-z]') return false;
    if (u.character === '<') return false;
    if (u.character === '[') return false;
    if (u.character === '(') return false;
    if (u.character === '`') return false;
    if (
      (u.character === '*' || u.character === '_' || u.character === '~') &&
      u.inConstruct === 'phrasing'
    ) {
      return false;
    }
    if (u.character === '=' && u.atBreak === true) return false;
    if (u.character === ' ' && u.inConstruct === 'phrasing' && u.after === '[\\r\\n]') {
      return false;
    }
    if (u.character === '\t' && u.inConstruct === 'phrasing' && u.after === '[\\r\\n]') {
      return false;
    }
    return true;
  });
  let result: string;
  try {
    result = state.safe(value, info);
  } finally {
    state.unsafe = originalUnsafe;
  }
  return escapeEntityAmpersands(escapeActiveDelimiterRuns(result, info));
}

const CHARACTER_GROUP_WHITESPACE = 1;

const CHARACTER_GROUP_PUNCTUATION = 2;

type FlankClass = 'ws' | 'punct' | 'other';

function classifyFlank(code: number): FlankClass {
  if (Number.isNaN(code)) return 'ws';
  const group = classifyCharacter(code);
  if (group === CHARACTER_GROUP_WHITESPACE) return 'ws';
  if (group === CHARACTER_GROUP_PUNCTUATION) return 'punct';
  return 'other';
}

function isActiveDelimiterRun(
  marker: '*' | '_' | '~',
  beforeCode: number,
  afterCode: number,
): boolean {
  const before = classifyFlank(beforeCode);
  const after = classifyFlank(afterCode);
  const leftFlanking = after !== 'ws' && (after === 'other' || before !== 'other');
  const rightFlanking = before !== 'ws' && (before === 'other' || after !== 'other');
  if (marker === '_') {
    const canOpen = leftFlanking && (!rightFlanking || before === 'punct');
    const canClose = rightFlanking && (!leftFlanking || after === 'punct');
    return canOpen || canClose;
  }
  return leftFlanking || rightFlanking;
}

function isSetextUnderlineShape(value: string, runEnd: number, info: Info): boolean {
  let k = runEnd;
  while (k < value.length && (value[k] === ' ' || value[k] === '\t')) k++;
  if (k < value.length) return value[k] === '\n' || value[k] === '\r';
  const next = info.after.charCodeAt(0);
  return Number.isNaN(next) || next === 0x0a || next === 0x0d;
}

function escapeActiveDelimiterRuns(value: string, info: Info): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    const ch = value.charAt(i);
    if (ch === '\\') {
      result += value.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~' || ch === '=') {
      let j = i + 1;
      while (j < value.length && value.charAt(j) === ch) j++;
      const beforeCode =
        i === 0 ? info.before.charCodeAt(info.before.length - 1) : value.charCodeAt(i - 1);
      if (ch === '=') {
        const atLineStart = Number.isNaN(beforeCode) || beforeCode === 0x0a || beforeCode === 0x0d;
        result +=
          atLineStart && isSetextUnderlineShape(value, j, info)
            ? `\\${value.slice(i, j)}`
            : value.slice(i, j);
      } else {
        const afterCode = j < value.length ? value.charCodeAt(j) : info.after.charCodeAt(0);
        result += isActiveDelimiterRun(ch, beforeCode, afterCode)
          ? `\\${ch}`.repeat(j - i)
          : value.slice(i, j);
      }
      i = j;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

function encodeAttentionBoundaries(between: string, info: Info, delim: string): string {
  const marker: '*' | '_' = delim.startsWith('_') ? '_' : '*';
  const before = info.before ?? '';
  const after = info.after ?? '';
  let result = between;
  const head = result.charCodeAt(0);
  if (shouldEncodeAttentionBoundary(before.charCodeAt(before.length - 1), head, marker)) {
    result = encodeCharacterReference(head) + result.slice(1);
  }
  const tail = result.charCodeAt(result.length - 1);
  if (shouldEncodeAttentionBoundary(after.charCodeAt(0), tail, marker)) {
    result = result.slice(0, -1) + encodeCharacterReference(tail);
  }
  return result;
}

function shouldEncodeAttentionBoundary(
  outside: number,
  inside: number,
  marker: '*' | '_',
): boolean {
  if (classifyCharacter(inside) !== CHARACTER_GROUP_WHITESPACE) return false;
  if (marker === '_' && classifyCharacter(outside) === undefined) return false;
  return true;
}

function encodeCharacterReference(code: number): string {
  return `&#x${code.toString(16).toUpperCase()};`;
}

function serializeInlineMath(
  node: Extract<Nodes, { type: 'inlineMath' }>,
  _parent: Parents | undefined,
  state: State,
  info: Info,
): string {
  let value = node.value ?? '';
  const captured = node.data?.sourceDelimiter;
  let size = typeof captured === 'string' && /^\$+$/.test(captured) ? captured.length : 2;
  if (size === 1 && !singleDollarMathReparses(value, info)) {
    size = 2;
  }
  while (new RegExp(`(^|[^$])${'\\$'.repeat(size)}([^$]|$)`).test(value)) {
    size++;
  }
  const sequence = '$'.repeat(size);
  if (
    /[^ \r\n]/.test(value) &&
    ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^\$|\$$/.test(value))
  ) {
    value = ` ${value} `;
  }
  let index = -1;
  while (++index < state.unsafe.length) {
    const pattern = state.unsafe[index];
    if (!pattern.atBreak) continue;
    const expression = state.compilePattern(pattern);
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
    while ((match = expression.exec(value)) !== null) {
      let position = match.index;
      if (value.codePointAt(position) === 10 && value.codePointAt(position - 1) === 13) {
        position--;
      }
      value = `${value.slice(0, position)} ${value.slice(match.index + 1)}`;
    }
  }
  return sequence + value + sequence;
}

function serializeDelete(
  node: Extract<Nodes, { type: 'delete' }>,
  _parent: Parents | undefined,
  state: State,
  info: Info,
): string {
  const delim = node.data?.sourceDelimiter === '~' ? '~' : '~~';
  const tracker = state.createTracker(info);
  const exit = state.enter('strikethrough');
  let value = tracker.move(delim);
  value += encodeAttentionBoundaries(
    state.containerPhrasing(node, {
      ...tracker.current(),
      before: value,
      after: '~',
    }),
    info,
    delim,
  );
  value += tracker.move(delim);
  exit();
  return value;
}

function singleDollarMathReparses(value: string, info: Info): boolean {
  if (value.length === 0) return false;
  if (!/^\S/.test(value) || !/\S$/.test(value)) return false;
  if (/[$\r\n]/.test(value)) return false;
  if (value.endsWith('\\') || /\\[!-/:-@[-`{-~]/.test(value)) return false;
  if (/^\d/.test(info.after)) return false;
  if (info.before.endsWith('\\')) return false;
  return true;
}
