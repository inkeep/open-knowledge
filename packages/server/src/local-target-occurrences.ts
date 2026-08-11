/**
 * Lossless extraction of local-target link/image occurrences from a document's
 * markdown source. One positioned record per authored occurrence — every
 * supported syntax reduced to a common shape so downstream assessment
 * (existence, reason, projection) works from the same authored intent.
 *
 * This is recognition + positioning only. It does NOT resolve a target to a
 * project identity or check existence (a later assessment layer owns that): the
 * record carries the authored href and an exact source range, and reference-style
 * uses carry a pointer to their shared definition. Authored bytes are never
 * rewritten; `source.slice(range.start, range.end)` reproduces an occurrence
 * verbatim.
 *
 * Recognition reuses the shared grammar in `link-syntax.ts`. Only targets that
 * could be project-local enter the result — external URLs and bare anchors are
 * dropped here so no consumer mistakes them for a local file.
 */

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

/** Whether the occurrence renders as a link (navigable) or an image (embedded). */
type OccurrenceRole = 'link' | 'image';

/** The authored syntax family an occurrence came from. */
export type OccurrenceSourceForm =
  | 'markdown-inline'
  | 'markdown-reference'
  | 'html-img'
  | 'wiki-link'
  | 'wiki-embed';

interface SourceRange {
  /** Inclusive start char offset into the full raw document source. */
  start: number;
  /** Exclusive end char offset. `source.slice(start, end)` reproduces the authored occurrence. */
  end: number;
}

interface ReferenceDefinition {
  /** Normalized (case-folded, whitespace-collapsed) label. */
  label: string;
  /** Destination as authored, angle-unwrapped. */
  href: string;
  /** Destination exactly as authored, including any `<…>` wrapper. */
  hrefRaw: string;
  /** Source range of the destination token — where a rewriter repairs the link. */
  repairRange: SourceRange;
  /** 0-based full-document line of the definition. */
  line: number;
}

interface ReferenceUseDetail {
  /** Normalized label this use resolved against. */
  label: string;
  /** Authored reference shape. */
  kind: 'full' | 'collapsed' | 'shortcut';
  /**
   * The definition this use points at. Uses of the same label share one object
   * identity, so a repair to the definition heals every use. Present on every
   * emitted reference occurrence — a use with no matching definition is not a
   * link and is not emitted.
   */
  definition: ReferenceDefinition;
}

export interface LocalTargetOccurrence {
  role: OccurrenceRole;
  sourceForm: OccurrenceSourceForm;
  /**
   * Authored destination href. For a reference use this is the shared
   * definition's destination; for a wiki form it is the target token.
   */
  href: string;
  /** Exact source range of the whole authored occurrence. */
  range: SourceRange;
  /** 0-based full-document line of the occurrence. */
  line: number;
  /** 0-based column (char offset from the line start) of the occurrence. */
  column: number;
  /** Present for reference-style uses only. */
  reference?: ReferenceUseDetail;
}

interface BodyLine {
  text: string;
  /** Offset of the line's first char within the frontmatter-stripped body. */
  start: number;
}

interface ReferenceDefinitionBlock {
  match: ReferenceDefinitionMatch;
  /** Line holding `[label]:`; a continued destination may live on the next line. */
  definitionLine: number;
  /** Body-relative offset of the destination token. */
  destinationOffset: number;
  /** Every source line consumed by the definition, including a continued title. */
  consumedLines: number[];
}

interface DefinitionCollection {
  definitions: Map<string, ReferenceDefinition>;
  definitionLines: Set<number>;
}

/**
 * CommonMark label matching folds case and collapses internal whitespace, so
 * `[Foo Bar]` and `[foo   bar]` resolve to one definition. Trimming handles the
 * leading/trailing whitespace a collapsed/shortcut label may carry. The
 * collapse set is micromark's markdown whitespace, `[\t\n\r ]` — `\s` would
 * also collapse non-markdown whitespace (NBSP), unifying labels CommonMark
 * keeps distinct. The shared core helper matches micromark's Unicode-aware
 * CommonMark identifier keys.
 */
/**
 * True when an authored href could name a project-local target. Excludes
 * external URLs (any scheme, protocol-relative) and bare anchors, which are
 * never local files, and empty destinations. A relative or root-relative path —
 * including one that walks past the root — passes; deciding whether it resolves
 * is the assessment layer's job, not recognition's.
 */
function isLocalTargetCandidateHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  return !isExternalHref(trimmed);
}

/**
 * Split a body into lines with their byte offsets, preserving `\r\n` / `\r` / `\n`
 * exactly (no normalization) so ranges map onto the raw source. Each line's
 * `text` excludes its terminator; `start` is the offset of its first char.
 */
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

/** Count line terminators (`\n`, `\r`, `\r\n`) — the body's first line index. */
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
  /** Full-document offset of the line's first char. */
  lineOffset: number;
  /** 0-based full-document line number. */
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

/**
 * Resolve a reference use against the definition table and emit it when it
 * resolves to a local-target candidate. Returns the index to resume scanning
 * from: the whole form is consumed whether or not it emits, matching CommonMark's
 * treatment of an unresolved reference as literal text.
 */
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

/**
 * Scan one body line for occurrences. Escapes, inline code, and both bracket
 * families are honored so a link inside code, or one whose `[` is backslash-
 * escaped, never produces a false occurrence. Dispatch order mirrors the
 * backlink indexer: wiki forms before markdown so `[[…]]` is not re-read as a
 * markdown link.
 */
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
      // Badge form: the outer link and inner image are two independently
      // repairable destinations. The strict matcher intentionally reads the
      // inner destination at the outer opener, so recognize this composition
      // before the generic branch and emit both exact ranges.
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

/** Parse the one-, two-, or three-line CommonMark definition beginning at `index`. */
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

/**
 * First pass: collect every link reference definition, keyed by normalized
 * label. The first definition of a label wins (CommonMark). Input lines already
 * have fenced code and non-rendering HTML regions positionally masked; indented
 * definitions are rejected by the definition grammar.
 */
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
      // Keep the longstanding lowercase evidence shown to users while the map
      // key follows CommonMark's full Unicode folding.
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

/**
 * Extract every project-local-target link/image occurrence from a document's
 * markdown source. Frontmatter and fenced code are excluded; reference uses are
 * resolved against the document's own definitions.
 */
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
    // Definition blocks render no content, so none of their consumed lines hold
    // uses. Skipping all of them also prevents a continued title from being
    // interpreted as ordinary body text.
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
