import {
  isExternalHref,
  maskNonRenderingContextLines,
  normalizeReferenceLabel,
  skipInlineCode,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import {
  type HtmlImgMatch,
  type MarkdownReferenceMatch,
  type ReferenceDefinitionMatch,
  readHtmlImgAt,
  readMarkdownLinkAt,
  readMarkdownReferenceAt,
  readReferenceDefinition,
  readWikiLinkAt,
  type WikiLinkMatch,
} from './link-syntax.ts';

type OccurrenceRole = 'link' | 'image';

export type OccurrenceSourceForm =
  | 'markdown-inline'
  | 'markdown-reference'
  | 'html-img'
  | 'wiki-link'
  | 'wiki-embed';

interface SourceRange {
  start: number;
  end: number;
}

interface ReferenceDefinition {
  label: string;
  href: string;
  hrefRaw: string;
  repairRange: SourceRange;
  line: number;
}

interface ReferenceUseDetail {
  label: string;
  kind: 'full' | 'collapsed' | 'shortcut';
  definition: ReferenceDefinition;
}

export interface LocalTargetOccurrence {
  role: OccurrenceRole;
  sourceForm: OccurrenceSourceForm;
  href: string;
  range: SourceRange;
  line: number;
  column: number;
  reference?: ReferenceUseDetail;
}

interface BodyLine {
  text: string;
  start: number;
}

interface ReferenceDefinitionBlock {
  match: ReferenceDefinitionMatch;
  definitionLine: number;
  destinationOffset: number;
  consumedLines: number[];
}

interface DefinitionCollection {
  definitions: Map<string, ReferenceDefinition>;
  definitionLines: Set<number>;
}

function isLocalTargetCandidateHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  return !isExternalHref(trimmed);
}

function splitLinesWithOffsets(body: string): BodyLine[] {
  const lines: BodyLine[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\n') {
      lines.push({ text: body.slice(start, i), start });
      start = i + 1;
    } else if (ch === '\r') {
      lines.push({ text: body.slice(start, i), start });
      if (body[i + 1] === '\n') i += 1;
      start = i + 1;
    }
  }
  lines.push({ text: body.slice(start), start });
  return lines;
}

function countLineTerminators(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      count += 1;
    } else if (text[i] === '\r') {
      count += 1;
      if (text[i + 1] === '\n') i += 1;
    }
  }
  return count;
}

interface ScanContext {
  lineOffset: number;
  lineNumber: number;
  definitions: Map<string, ReferenceDefinition>;
  out: LocalTargetOccurrence[];
}

function pushOccurrence(
  ctx: ScanContext,
  fields: Omit<LocalTargetOccurrence, 'range' | 'line' | 'column'> & {
    startCol: number;
    endCol: number;
  },
): void {
  const { startCol, endCol, ...rest } = fields;
  ctx.out.push({
    ...rest,
    range: { start: ctx.lineOffset + startCol, end: ctx.lineOffset + endCol },
    line: ctx.lineNumber,
    column: startCol,
  });
}

function emitWiki(ctx: ScanContext, match: WikiLinkMatch, startCol: number): void {
  if (!isLocalTargetCandidateHref(match.target)) return;
  pushOccurrence(ctx, {
    role: match.embed ? 'image' : 'link',
    sourceForm: match.embed ? 'wiki-embed' : 'wiki-link',
    href: match.target,
    startCol,
    endCol: match.end,
  });
}

function emitHtmlImg(ctx: ScanContext, match: HtmlImgMatch, startCol: number): void {
  if (!isLocalTargetCandidateHref(match.src)) return;
  pushOccurrence(ctx, {
    role: 'image',
    sourceForm: 'html-img',
    href: match.src,
    startCol,
    endCol: match.end,
  });
}

function handleReference(ctx: ScanContext, ref: MarkdownReferenceMatch): number {
  const key =
    ref.form === 'full'
      ? normalizeReferenceLabel(ref.referenceLabelRaw)
      : normalizeReferenceLabel(ref.label);
  const definition = ctx.definitions.get(key);
  if (definition && isLocalTargetCandidateHref(definition.href)) {
    pushOccurrence(ctx, {
      role: ref.image ? 'image' : 'link',
      sourceForm: 'markdown-reference',
      href: definition.href,
      startCol: ref.start,
      endCol: ref.end,
      reference: { label: definition.label, kind: ref.form, definition },
    });
  }
  return ref.end;
}

function scanLine(ctx: ScanContext, line: string): void {
  let idx = 0;
  while (idx < line.length) {
    const ch = line[idx];

    if (ch === '\\') {
      idx += 2;
      continue;
    }

    if (ch === '`') {
      const next = skipInlineCode(line, idx);
      if (next !== null) {
        idx = next;
        continue;
      }
    }

    if (ch === '<') {
      const img = readHtmlImgAt(line, idx);
      if (img) {
        emitHtmlImg(ctx, img, idx);
        idx = img.end;
        continue;
      }
    }

    if (ch === '!' && line[idx + 1] === '[' && line[idx + 2] === '[') {
      const wiki = readWikiLinkAt(line, idx);
      if (wiki) {
        emitWiki(ctx, wiki, idx);
        idx = wiki.end;
      } else {
        idx += 1;
      }
      continue;
    }

    if (ch === '[' && line[idx + 1] === '[') {
      const wiki = readWikiLinkAt(line, idx);
      if (wiki) {
        emitWiki(ctx, wiki, idx);
        idx = wiki.end;
      } else {
        idx += 1;
      }
      continue;
    }

    if (ch === '!' && line[idx + 1] === '[') {
      const inline = readMarkdownLinkAt(line, idx);
      if (inline?.image) {
        if (isLocalTargetCandidateHref(inline.href)) {
          pushOccurrence(ctx, {
            role: 'image',
            sourceForm: 'markdown-inline',
            href: inline.href,
            startCol: idx,
            endCol: inline.end,
          });
        }
        idx = inline.end;
        continue;
      }
      const ref = readMarkdownReferenceAt(line, idx);
      if (ref?.image) {
        idx = handleReference(ctx, ref);
        continue;
      }
    }

    if (ch === '[') {
      const innerImage = readMarkdownLinkAt(line, idx + 1);
      const outerLink = readMarkdownLinkAt(line, idx, { nestedBracketLabels: true });
      if (
        innerImage?.image === true &&
        outerLink?.image === false &&
        outerLink.end > innerImage.end &&
        line[innerImage.end] === ']'
      ) {
        if (isLocalTargetCandidateHref(outerLink.href)) {
          pushOccurrence(ctx, {
            role: 'link',
            sourceForm: 'markdown-inline',
            href: outerLink.href,
            startCol: idx,
            endCol: outerLink.end,
          });
        }
        if (isLocalTargetCandidateHref(innerImage.href)) {
          pushOccurrence(ctx, {
            role: 'image',
            sourceForm: 'markdown-inline',
            href: innerImage.href,
            startCol: idx + 1,
            endCol: innerImage.end,
          });
        }
        idx = outerLink.end;
        continue;
      }

      const inline = readMarkdownLinkAt(line, idx);
      if (inline && !inline.image) {
        if (isLocalTargetCandidateHref(inline.href)) {
          pushOccurrence(ctx, {
            role: 'link',
            sourceForm: 'markdown-inline',
            href: inline.href,
            startCol: idx,
            endCol: inline.end,
          });
        }
        idx = inline.end;
        continue;
      }
      const ref = readMarkdownReferenceAt(line, idx);
      if (ref && !ref.image) {
        idx = handleReference(ctx, ref);
        continue;
      }
    }

    idx += 1;
  }
}

const REFERENCE_HEADER_ONLY_RE = /^( {0,3}\[([^\]\n]+)\]:)[ \t]*$/;
const REFERENCE_DESTINATION_CONTINUATION_RE =
  /^([ \t]*)(<[^>\n]*>|[^\s\n]+)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)[ \t]*$/;
const REFERENCE_TITLE_ONLY_RE = /^[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))[ \t]*$/;

function continuedTitleLine(lines: BodyLine[], index: number): number | null {
  const next = lines[index + 1]?.text;
  return next !== undefined && REFERENCE_TITLE_ONLY_RE.test(next) ? index + 1 : null;
}

function readReferenceDefinitionBlock(
  lines: BodyLine[],
  index: number,
): ReferenceDefinitionBlock | null {
  const line = lines[index];
  if (!line) return null;
  const direct = readReferenceDefinition(line.text);
  if (direct) {
    const titleLine = direct.titleSuffix ? null : continuedTitleLine(lines, index);
    return {
      match: direct,
      definitionLine: index,
      destinationOffset: line.start + direct.destinationStart,
      consumedLines: titleLine === null ? [index] : [index, titleLine],
    };
  }

  const header = REFERENCE_HEADER_ONLY_RE.exec(line.text);
  const destinationLine = lines[index + 1];
  if (!header || !destinationLine) return null;
  const continuation = REFERENCE_DESTINATION_CONTINUATION_RE.exec(destinationLine.text);
  if (!continuation) return null;
  const destinationRaw = continuation[2] ?? '';
  const destinationIndent = continuation[1]?.length ?? 0;
  const titleSuffix = continuation[3] ?? '';
  const titleLine = titleSuffix ? null : continuedTitleLine(lines, index + 1);
  return {
    match: {
      label: header[2] ?? '',
      destinationRaw,
      destination:
        destinationRaw.startsWith('<') && destinationRaw.endsWith('>')
          ? destinationRaw.slice(1, -1)
          : destinationRaw,
      destinationStart: destinationIndent,
      destinationEnd: destinationIndent + destinationRaw.length,
      titleSuffix,
    },
    definitionLine: index,
    destinationOffset: destinationLine.start + destinationIndent,
    consumedLines: titleLine === null ? [index, index + 1] : [index, index + 1, titleLine],
  };
}

function collectDefinitions(
  lines: BodyLine[],
  bodyOffset: number,
  lineNumberOffset: number,
): DefinitionCollection {
  const definitions = new Map<string, ReferenceDefinition>();
  const definitionLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const block = readReferenceDefinitionBlock(lines, i);
    if (!block) continue;
    for (const line of block.consumedLines) definitionLines.add(line);
    const { match } = block;
    const key = normalizeReferenceLabel(match.label);
    if (definitions.has(key)) {
      i = block.consumedLines.at(-1) ?? i;
      continue;
    }
    definitions.set(key, {
      label: key.toLowerCase(),
      href: match.destination,
      hrefRaw: match.destinationRaw,
      repairRange: {
        start: bodyOffset + block.destinationOffset,
        end: bodyOffset + block.destinationOffset + match.destinationRaw.length,
      },
      line: lineNumberOffset + block.definitionLine,
    });
    i = block.consumedLines.at(-1) ?? i;
  }
  return { definitions, definitionLines };
}

export function extractLocalTargetOccurrences(markdown: string): LocalTargetOccurrence[] {
  const { frontmatter, body } = stripFrontmatter(markdown);
  const bodyOffset = frontmatter.length;
  const lineNumberOffset = countLineTerminators(frontmatter);
  const sourceLines = splitLinesWithOffsets(body);
  const lines = maskNonRenderingContextLines(sourceLines);

  const { definitions, definitionLines } = collectDefinitions(lines, bodyOffset, lineNumberOffset);

  const out: LocalTargetOccurrence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { text, start } = lines[i] as BodyLine;
    if (definitionLines.has(i)) continue;
    if (/^(?: {4}|\t)/.test(sourceLines[i]?.text ?? '')) continue;
    scanLine(
      {
        lineOffset: bodyOffset + start,
        lineNumber: lineNumberOffset + i,
        definitions,
        out,
      },
      text,
    );
  }
  return out;
}
