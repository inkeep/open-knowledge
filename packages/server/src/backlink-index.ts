import { type Dirent, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type BrokenLinkReason,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  extractSkillRefs,
  getWikiLinkText,
  isOrphanMode,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  ORPHAN_MODES,
  type OrphanMode,
  parseGlobalSkillBundleDoc,
  parseProjectSkillBundleDoc,
  resolveAssetProjectPath,
  resolveInternalHref,
  resolveSkillBundleWikiTarget,
  resolveWikiLinkTarget,
  resolveWikiLinkTargetDocName,
  skillLiveDocName,
  stripFrontmatter,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { instrumentIndexRebuild } from './index-telemetry.ts';
import { readMarkdownLinkAt, readWikiLinkAt } from './link-syntax.ts';
import { extractLocalTargetOccurrences } from './local-target-occurrences.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';

const log = getLogger('backlinks');

interface InlineWikiLinkOccurrence {
  target: string;
  anchor: string | null;
  start: number;
  end: number;
  rawWikiTarget?: boolean;
}

/**
 * The one inventory question the graph plane has to ask before it can decide
 * whether an extension-less href names a document.
 *
 * Without it this plane has no file inventory at all, so it reads
 * `assets/NOTICE` as a document and emits a dead-document edge for a file that
 * is right there on disk — while the local-target plane, which does see the
 * files, calls the same occurrence an existing file. Structurally satisfied by
 * `LocalTargetInventory`, so the two planes share one oracle rather than each
 * growing their own.
 *
 * Optional at every entry point: a caller with no inventory (a rebuild before
 * the file index has seeded, a test exercising graph shape alone) keeps the
 * document-shaped reading, which is the safe default when existence is unknown.
 */
export interface GraphFileOracle {
  /** Whether a content-root-relative path names an admitted ordinary file. */
  hasFile(contentRootRelativePath: string): boolean;
}

/**
 * Whether an extension-less doc-shaped href actually names an existing ordinary
 * file, which makes it NOT a document edge.
 *
 * Mirrors the local-target plane's disambiguation: document identity is decided
 * by the caller, and an exact file hit is what overrides it. An href carrying a
 * document extension is never re-read as a file, so `notes/guide.md` stays a
 * document even if some file of that name is tracked.
 */
function namesExistingFile(
  href: string,
  sourceDocName: string,
  oracle: GraphFileOracle | undefined,
): boolean {
  if (!oracle) return false;
  if (isSupportedDocFile(href)) return false;
  // Markdown plane only: both callers hand this a markdown destination (an
  // inline `[text](href)` and a reference definition's destination), which is a
  // URI whose escapes decode. Wiki targets never reach here — they resolve by
  // vault-wide basename, not by a source-relative path.
  const filePath = resolveAssetProjectPath(href, sourceDocName, { literal: false });
  return filePath !== null && oracle.hasFile(filePath);
}

interface FenceState {
  char: '`' | '~';
  length: number;
}

export interface ExtractedWikiLink {
  target: string;
  anchor: string | null;
  snippet: string | null;
  /** Authored syntax that produced this graph edge. */
  sourceForm?: 'wiki' | 'markdown';
  /**
   * 0-based source line of the occurrence (the extractor's `lineOffset` param
   * folds a stripped-frontmatter prefix back in, keeping this full-doc exact).
   */
  line?: number;
  /**
   * 0-based offset into the markdown-stripped flat rendering of the line —
   * approximate against the raw source column (escapes, inline-code backticks,
   * and leading list/heading prefixes are collapsed before offsets are taken).
   */
  column?: number;
  /**
   * The target was recorded verbatim because index time could not decide what
   * it names. The syntactic classifier reads anything ending in a dot-suffix as
   * a file (`acp.daemon` = an `acp` with extension `daemon`), which is right for
   * `[[diagram.png]]` and wrong for a document literally named `acp.daemon.md`.
   * Telling them apart needs the corpus, and the corpus is only complete at
   * query time — deciding here would make the answer depend on file ordering and
   * would let the mtime-keyed cache persist a stale verdict across restarts.
   *
   * Consumers must treat such a target as UNDECIDED, never as a missing
   * document: it is resolved against the document set at query time, and a
   * target that resolves to nothing stays silent rather than being reported
   * broken. Absent/false means the target is already a resolved docName (a
   * markdown href, or a wiki target the classifier called a document), which
   * keeps its existing report-when-missing behaviour.
   */
  rawWikiTarget?: boolean;
}

interface ExtractedExternalLink {
  url: string;
  label: string | null;
  snippet: string | null;
}

export interface BacklinkEntry {
  source: string;
  anchor: string | null;
  snippet: string | null;
  /** Authored syntax retained for cross-plane audit reconciliation. */
  sourceForm?: 'wiki' | 'markdown';
  /**
   * 0-based full-doc position of the link occurrence in the source doc (line
   * exact, column approximate — see `ExtractedWikiLink`). Absent on entries
   * deserialized from a cache written before positions were indexed; re-indexing
   * the source doc fills them in.
   */
  line?: number;
  column?: number;
}

interface DocumentForwardLinkEntry {
  kind: 'doc';
  target: string;
  anchor: string | null;
  snippet: string | null;
}

interface ExternalForwardLinkEntry {
  kind: 'external';
  url: string;
  label: string | null;
  snippet: string | null;
}

type ForwardLinkEntry = DocumentForwardLinkEntry | ExternalForwardLinkEntry;

export interface HubEntry {
  docName: string;
  count: number;
}

interface DeadLinkEntry {
  target: string;
  sources: BacklinkEntry[];
}

interface DocGraphNode {
  kind: 'doc';
  id: string;
  docName: string;
  anchor: string | null;
}

interface ExternalGraphNode {
  kind: 'external';
  id: string;
  url: string;
  label: string | null;
}

export type GraphNode = DocGraphNode | ExternalGraphNode;

export { isOrphanMode, ORPHAN_MODES, type OrphanMode };

interface BackwardLinkMeta {
  anchor: string | null;
  snippet: string | null;
  sourceForm?: 'wiki' | 'markdown';
  line?: number;
  column?: number;
  /** See {@link ExtractedWikiLink.rawWikiTarget}. */
  rawWikiTarget?: boolean;
}

interface BranchGraphState {
  backward: Map<string, Map<string, BackwardLinkMeta>>;
  forward: Map<string, Set<string>>;
  externalForward: Map<string, Map<string, { label: string | null; snippet: string | null }>>;
  externalBackward: Map<string, Map<string, { label: string | null; snippet: string | null }>>;
  /** Per skill-bundle doc: the `/skill-name` reference tokens its body authors
   *  (names only, unresolved). Resolution to a SKILL doc happens at READ time
   *  against the live node registry — exactly like structural bundle edges —
   *  so an edge appears the moment the referenced skill is indexed, without
   *  re-parsing the referencing doc. */
  skillRefs: Map<string, Set<string>>;
  /**
   * Bumped on every `forward` mutation, which is a superset of the key-set
   * changes the cache below actually depends on — re-indexing a doc whose
   * links changed but whose name did not still invalidates. Conservative in
   * the safe direction: it rebuilds more often than strictly needed, never
   * less. The derived slug/basename
   * lookup query-time resolution reads is O(docs) with a slug computation per
   * doc, so it is cached against this counter rather than rebuilt per query —
   * rebuilding it inside the per-target scan would make that scan O(docs ×
   * targets). Not persisted: a reloaded snapshot is a fresh state object, and
   * the cache is keyed by object identity.
   */
  epoch: number;
}

/**
 * On-disk cache format version. A mismatch (including the versionless caches
 * written before the field existed) rejects the load, and the caller falls
 * back to a full cold rebuild. Bump when the meaning of a persisted key
 * changes — e.g. v1 retired the `__template__/…` link-target namespace, and a
 * pre-v1 cache carrying an edge under that key would otherwise surface a false
 * dead link (`getDeadLinks`) and a false orphan (`getOrphans`) until the
 * source doc happened to be re-parsed.
 *
 * Bump on an ADDED key too, not just a changed one. v2 covers `skillRefs`:
 * added as an optional field without a bump, so v1 caches stayed loadable and
 * deserialized it to empty. The mtime reconcile then skips every unchanged
 * file, so `recordSkillRefs` never runs for them and every `/skill-name` edge
 * a project skill authors is missing until that file happens to be edited.
 * Global bundles hid the bug — `ingestGlobalSkillBundles` re-reads them on
 * every boot, so their refs looked fine while project skills had none.
 */
const SNAPSHOT_VERSION = 2;

interface SerializedBranchGraphState {
  version?: number;
  backward: Record<string, Array<BacklinkEntry & { rawWikiTarget?: boolean }>>;
  forward: Record<string, string[]>;
  externalForward: Record<
    string,
    Array<{ url: string; label: string | null; snippet: string | null }>
  >;
  /** `/skill-name` reference tokens per skill-bundle doc (see BranchGraphState). */
  skillRefs?: Record<string, string[]>;
  /**
   * Per-doc mtime snapshot written by rebuildFromDisk / reconcileWithDisk.
   * Used on next startup to skip re-parsing files whose mtime hasn't changed.
   * Optional for backward compatibility — absent means treat all files as new.
   */
  mtimes?: Record<string, number>;
}

interface BacklinkIndexOptions {
  projectDir: string;
  contentDir: string;
  contentFilter?: ContentFilter;
  /**
   * Existence oracle for ordinary files, so an extension-less href naming a
   * tracked file is not read as a document edge. Supplied as a getter because
   * the file inventory seeds asynchronously and lives in a sibling index — the
   * graph must read it live, not capture it at construction.
   */
  getFileOracle?: () => GraphFileOracle | undefined;
}

function createEmptyState(): BranchGraphState {
  return {
    backward: new Map(),
    forward: new Map(),
    externalForward: new Map(),
    externalBackward: new Map(),
    skillRefs: new Map(),
    epoch: 0,
  };
}

/**
 * Whether every source that references `target` recorded it as an undecided raw
 * wiki target (see {@link ExtractedWikiLink.rawWikiTarget}). A target reached by
 * even one resolved docName — a markdown href, or a wiki target the classifier
 * called a document — is decided, and keeps its report-when-missing behaviour.
 */
function isUndecidedTarget(state: BranchGraphState, target: string): boolean {
  const sources = state.backward.get(target);
  if (!sources || sources.size === 0) return false;
  for (const meta of sources.values()) {
    if (meta.rawWikiTarget !== true) return false;
  }
  return true;
}

/**
 * Scope-uniform parse of a skill bundle doc (PROJECT content doc OR GLOBAL
 * managed-artifact doc) into the three fields the structural-edge logic needs:
 * the skill `name`, the bundle `kind`, and the doc name of the bundle's `SKILL`
 * doc in the SAME scope. Returning the scope-correct SKILL doc name from one
 * place lets `structuralBundleNeighbors` draw within-bundle edges identically
 * for both scopes — a global SKILL connects only to global references of the
 * same skill, a project SKILL only to project references, never across the
 * scope boundary or into a project's KB.
 */
export function parseSkillBundleDocAnyScope(
  docName: string,
): { name: string; kind: 'skill' | 'reference'; skillDocName: string } | null {
  const project = parseProjectSkillBundleDoc(docName);
  if (project) {
    // The SKILL doc name derives from the bundle doc's OWN root — a reference
    // at `.agents/skills/<name>/references/x` pairs with
    // `.agents/skills/<name>/SKILL`. Minting a shape here (the old
    // `skillLiveDocName` route) silently broke every in-place bundle after the
    // store retirement: it produced `.ok/skills/<name>/SKILL`, which matches no
    // live in-place doc, so the structural edges never drew.
    const skillDocName =
      project.kind === 'skill' ? docName : `${docName.split('/references/')[0]}/SKILL`;
    return {
      name: project.name,
      kind: project.kind,
      skillDocName,
    };
  }
  const global = parseGlobalSkillBundleDoc(docName);
  if (global) {
    return {
      name: global.name,
      kind: global.kind,
      skillDocName: skillLiveDocName('global', global.name),
    };
  }
  return null;
}

function mergeLinkMeta(
  existing: BackwardLinkMeta | undefined,
  next: BackwardLinkMeta,
): BackwardLinkMeta {
  if (!existing) return next;
  // The position travels as a (line, column) unit — mixing one occurrence's
  // line with another's column would point at a coordinate no link occupies.
  const positioned = existing.line !== undefined ? existing : next;
  return {
    anchor: existing.anchor ?? next.anchor,
    snippet: existing.snippet ?? next.snippet,
    sourceForm: existing.sourceForm ?? next.sourceForm,
    line: positioned.line,
    column: positioned.column,
    // One decided occurrence settles the target for this source: a doc named
    // outright is a doc no matter how many undecided occurrences sit beside it.
    rawWikiTarget: existing.rawWikiTarget === true && next.rawWikiTarget === true,
  };
}

function getRepresentativeAnchor(
  sources: Map<string, BackwardLinkMeta> | undefined,
): string | null {
  if (!sources) return null;
  for (const [, meta] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (meta.anchor) return meta.anchor;
  }
  return null;
}

function externalNodeId(url: string): string {
  return `external:${url}`;
}

function externalUrlFromNodeId(id: string): string | null {
  return id.startsWith('external:') ? id.slice('external:'.length) : null;
}

function normalizeSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

function snippetAround(text: string, start: number, end: number): string | null {
  const normalizedText = normalizeSnippet(text);
  if (!normalizedText) return null;

  const leftPunctuation = Math.max(
    text.lastIndexOf('.', start - 1),
    text.lastIndexOf('?', start - 1),
    text.lastIndexOf('!', start - 1),
    text.lastIndexOf('\n', start - 1),
  );
  const rightPunctuationCandidates = [
    text.indexOf('.', end),
    text.indexOf('?', end),
    text.indexOf('!', end),
    text.indexOf('\n', end),
  ].filter((idx) => idx >= 0);

  const rawStart = leftPunctuation >= 0 ? leftPunctuation + 1 : Math.max(0, start - 60);
  const rawEnd =
    rightPunctuationCandidates.length > 0
      ? Math.min(...rightPunctuationCandidates) + 1
      : Math.min(text.length, end + 60);

  const prefix = rawStart > 0 ? '…' : '';
  const suffix = rawEnd < text.length ? '…' : '';
  const snippet = normalizeSnippet(text.slice(rawStart, rawEnd));
  if (!snippet) return null;
  return `${prefix}${snippet}${suffix}`;
}

function matchFence(line: string): FenceState | null {
  const match = /^\s{0,3}([`~]{3,})/.exec(line);
  if (!match) return null;
  const fence = match[1];
  const char = fence[0];
  if (char !== '`' && char !== '~') return null;
  return { char, length: fence.length };
}

function isFenceClose(line: string, fence: FenceState): boolean {
  return new RegExp(`^\\s{0,3}\\${fence.char}{${fence.length},}\\s*$`).test(line);
}

function leadingMarkdownPrefixLength(line: string): number {
  const match = /^\s{0,3}(?:#{1,6}\s+|>\s+|(?:[-+*]|\d+[.)])\s+)/.exec(line);
  return match ? match[0].length : 0;
}

function readInlineCode(line: string, start: number): { text: string; nextIndex: number } | null {
  let runLength = 0;
  while (line[start + runLength] === '`') runLength++;
  if (runLength === 0) return null;
  const openEnd = start + runLength;

  // CommonMark §6.1: the closing backtick string must be exactly the same length
  // as the opening string and must not be preceded or followed by a backtick.
  // indexOf() would match inside a longer run, so we scan for exact-length runs.
  let i = openEnd;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let closeLen = 0;
    while (line[i + closeLen] === '`') closeLen++;
    if (closeLen === runLength) {
      return { text: line.slice(openEnd, i), nextIndex: i + runLength };
    }
    i += closeLen;
  }
  // Unmatched opening run. Per CommonMark §6.1, a backtick string is "neither
  // preceded nor followed by a backtick" — characters inside the run cannot
  // start a different (shorter) opening run. Treat the full run as literal
  // text and advance past it. Returning `nextIndex: start + 1` here would let
  // the caller's outer loop re-enter readInlineCode at every interior backtick
  // and re-scan to end of line, giving O(N²) work on a long unclosed run
  // (DoS attack vector via crafted markdown reaching the backlink indexer).
  return { text: line.slice(start, openEnd), nextIndex: openEnd };
}

function readWikiLink(
  line: string,
  start: number,
): { target: string; alias: string | null; anchor: string | null; nextIndex: number } | null {
  // core's parseWikiLink expects the string to start with '[[' (^ anchor) and
  // cannot be used here where start may be mid-line.
  const match = readWikiLinkAt(line, start);
  if (!match) return null;
  return {
    target: match.target,
    alias: match.alias,
    anchor: match.anchor,
    nextIndex: match.end,
  };
}

function extractWikiLinksFromLine(
  line: string,
  sourceDocName: string,
): {
  text: string;
  occurrences: InlineWikiLinkOccurrence[];
} {
  let flatText = '';
  const occurrences: InlineWikiLinkOccurrence[] = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        const label = getWikiLinkText(wikiLink);
        const start = flatText.length;
        flatText += label;
        const classified = classifyWikiLinkTarget(wikiLink.target, wikiLink.anchor);
        if (classified?.kind === 'doc') {
          // A bundle-relative wiki-link inside a SKILL.md (`[[references/x]]`)
          // is classified as a bare content-root doc; remap it to the sibling
          // bundle ref so the inbound edge lands on the real ref doc.
          const target =
            resolveSkillBundleWikiTarget(wikiLink.target, sourceDocName) ?? classified.docName;
          occurrences.push({
            target,
            anchor: classified.anchor,
            start,
            end: start + label.length,
          });
        } else if (classified?.kind === 'asset') {
          // Undecidable here — see `ExtractedWikiLink.rawWikiTarget`. Record the
          // target verbatim so a document whose name carries a dot stops being
          // invisible to link reporting, and let the query side resolve it.
          occurrences.push({
            target: classified.url,
            anchor: wikiLink.anchor?.trim() || null,
            start,
            end: start + label.length,
            rawWikiTarget: true,
          });
        }
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

function extractExternalWikiLinksFromLine(line: string): {
  text: string;
  occurrences: Array<{ url: string; label: string | null; start: number; end: number }>;
} {
  let flatText = '';
  const occurrences: Array<{ url: string; label: string | null; start: number; end: number }> = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        const label = getWikiLinkText(wikiLink);
        const start = flatText.length;
        flatText += label;
        const classified = classifyWikiLinkTarget(wikiLink.target, wikiLink.anchor);
        if (classified?.kind === 'external') {
          occurrences.push({
            url: classified.url,
            label,
            start,
            end: start + label.length,
          });
        }
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

/**
 * Resolve an href (from a markdown inline link) relative to a source docName.
 * Returns the resolved docName (no `.md` extension, no leading `./`) or null if
 * the href is external or escapes the content directory root.
 *
 * Resolution is pure string arithmetic — no filesystem access.
 */
export function resolveMarkdownHref(href: string, sourceDocName: string): string | null {
  return resolveInternalHref(href, sourceDocName)?.docName ?? null;
}

function readMarkdownLink(
  line: string,
  start: number,
): { text: string; href: string; nextIndex: number } | null {
  const match = readMarkdownLinkAt(line, start);
  if (!match) return null;
  return {
    text: match.label,
    href: match.href,
    nextIndex: match.end,
  };
}

function extractMarkdownLinksFromLine(
  line: string,
  sourceDocName: string,
  fileOracle?: GraphFileOracle,
): { text: string; occurrences: InlineWikiLinkOccurrence[] } {
  let flatText = '';
  const occurrences: InlineWikiLinkOccurrence[] = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    // Skip wiki-links so they're not double-counted as markdown links
    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        flatText += getWikiLinkText(wikiLink);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx - 1] !== '!') {
      const mdLink = readMarkdownLink(line, idx);
      if (mdLink) {
        const classified = classifyMarkdownHref(mdLink.href, sourceDocName);
        if (
          classified?.kind === 'doc' &&
          !namesExistingFile(mdLink.href, sourceDocName, fileOracle)
        ) {
          const start = flatText.length;
          flatText += mdLink.text;
          occurrences.push({
            target: classified.docName,
            anchor: classified.anchor,
            start,
            end: start + mdLink.text.length,
          });
        } else {
          // External link — add text to flat buffer without recording
          flatText += mdLink.text;
        }
        idx = mdLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

function extractExternalMarkdownLinksFromLine(
  line: string,
  sourceDocName: string,
): {
  text: string;
  occurrences: Array<{ url: string; label: string | null; start: number; end: number }>;
} {
  let flatText = '';
  const occurrences: Array<{ url: string; label: string | null; start: number; end: number }> = [];
  let idx = leadingMarkdownPrefixLength(line);

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      flatText += line[idx + 1];
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        flatText += inlineCode.text;
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        flatText += getWikiLinkText(wikiLink);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx - 1] !== '!') {
      const mdLink = readMarkdownLink(line, idx);
      if (mdLink) {
        const classified = classifyMarkdownHref(mdLink.href, sourceDocName);
        flatText += mdLink.text;
        if (classified?.kind === 'external') {
          const start = flatText.length - mdLink.text.length;
          occurrences.push({
            url: classified.url,
            label: mdLink.text || null,
            start,
            end: start + mdLink.text.length,
          });
        }
        idx = mdLink.nextIndex;
        continue;
      }
    }

    flatText += line[idx];
    idx++;
  }

  return { text: flatText, occurrences };
}

/**
 * Number of source lines a `stripFrontmatter` frontmatter block occupied —
 * the line offset that maps body-relative extractor lines back to full-doc
 * lines. The matched block always ends in a newline (or sits at EOF with an
 * empty body), so counting newlines after the extractors' own CRLF/CR
 * normalization equals the count of full lines removed.
 */
function frontmatterLineCount(frontmatter: string): number {
  if (!frontmatter) return 0;
  const normalized = frontmatter.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  let count = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '\n') count++;
  }
  return count;
}

export function extractMarkdownLinksFromMarkdown(
  markdown: string,
  sourceDocName: string,
  lineOffset = 0,
  fileOracle?: GraphFileOracle,
): ExtractedWikiLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedWikiLink[] = [];
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';

    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractMarkdownLinksFromLine(line, sourceDocName, fileOracle);
        links.push(
          ...extracted.occurrences.map(({ target, anchor, start, end }) => ({
            target,
            anchor,
            snippet: snippetAround(extracted.text, start, end),
            line: lineOffset + lineIndex,
            column: start,
          })),
        );
      }
    }
  }

  links.push(...extractReferenceLinksFromMarkdown(source, sourceDocName, lineOffset, fileOracle));

  return links;
}

/**
 * A line-initial `[label]:` — CommonMark's reference-definition opener, allowing
 * the up-to-three-space indent it permits and backslash-escaped brackets inside
 * the label (`[foo\]bar]:`). Permissive by design: a false positive just runs
 * the real extractor, which decides for itself.
 */
const HAS_REFERENCE_DEFINITION = /^ {0,3}\[(?:\\.|[^\\\]])*\]:/m;

/**
 * Document edges authored as reference-style links (`[text][label]`,
 * `[label][]`, `[label]`), whose destination lives in a separate definition.
 *
 * The line scanner above reads only inline destinations, so this pass is what
 * makes a reference-style document link visible to the graph. Without it,
 * Problems still warns (the local-target plane reads the definition straight
 * from source) while Outgoing, backlinks, orphans, hubs, and dead-links all
 * under-report by the same amount.
 *
 * Recognition is not re-implemented here. `extractLocalTargetOccurrences` is the
 * consolidated reader for every authored form, including reference resolution
 * and the full non-rendering-context masking, so this reuses it and keeps only
 * the graph-shaped projection: document-kind link occurrences, minus any that
 * name an existing ordinary file.
 */
function extractReferenceLinksFromMarkdown(
  source: string,
  sourceDocName: string,
  lineOffset: number,
  fileOracle: GraphFileOracle | undefined,
): ExtractedWikiLink[] {
  // The full occurrence extractor is the price of not re-implementing reference
  // resolution, and this runs per document on every rebuild and every write. A
  // reference use needs a matching definition to be a link at all, and a
  // definition is a line-initial `[label]:`, so a body without one cannot
  // contain a reference edge. Most documents have none, and they skip the pass.
  if (!HAS_REFERENCE_DEFINITION.test(source)) return [];

  const links: ExtractedWikiLink[] = [];
  for (const occurrence of extractLocalTargetOccurrences(source)) {
    if (occurrence.sourceForm !== 'markdown-reference' || occurrence.role !== 'link') continue;
    const classified = classifyMarkdownHref(occurrence.href, sourceDocName);
    if (classified?.kind !== 'doc') continue;
    if (namesExistingFile(occurrence.href, sourceDocName, fileOracle)) continue;
    links.push({
      target: classified.docName,
      anchor: classified.anchor,
      // The reference's visible text is its label, not its destination, and the
      // occurrence range covers the whole authored use — enough for a snippet
      // without re-flattening the line the way the inline scanner does.
      snippet: source.slice(occurrence.range.start, occurrence.range.end) || null,
      line: lineOffset + occurrence.line,
      column: occurrence.column,
    });
  }
  return links;
}

export function extractWikiLinksFromMarkdown(
  markdown: string,
  sourceDocName = '',
  lineOffset = 0,
): ExtractedWikiLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedWikiLink[] = [];
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';

    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractWikiLinksFromLine(line, sourceDocName);
        links.push(
          ...extracted.occurrences.map(({ target, anchor, start, end, rawWikiTarget }) => ({
            rawWikiTarget,
            target,
            anchor,
            snippet: snippetAround(extracted.text, start, end),
            line: lineOffset + lineIndex,
            column: start,
          })),
        );
      }
    }
  }

  return links;
}

function extractExternalWikiLinksFromMarkdown(markdown: string): ExtractedExternalLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedExternalLink[] = [];
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractExternalWikiLinksFromLine(line);
        links.push(
          ...extracted.occurrences.map(({ url, label, start, end }) => ({
            url,
            label,
            snippet: snippetAround(extracted.text, start, end),
          })),
        );
      }
    }
  }

  return links;
}

function extractExternalMarkdownLinksFromMarkdown(
  markdown: string,
  sourceDocName: string,
): ExtractedExternalLink[] {
  const source = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const links: ExtractedExternalLink[] = [];
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
      } else {
        const extracted = extractExternalMarkdownLinksFromLine(line, sourceDocName);
        links.push(
          ...extracted.occurrences.map(({ url, label, start, end }) => ({
            url,
            label,
            snippet: snippetAround(extracted.text, start, end),
          })),
        );
      }
    }
  }

  return links;
}

/**
 * One broken outbound link found in a doc's body, in the shape `write`/`edit`
 * surface to agents.
 *
 * - `href` — the link exactly as the author wrote it (a markdown href like
 *   `./wiki/x`, or the reconstructed `[[Page]]` form for a wiki link), so the
 *   agent can grep for it and fix it.
 * - `resolvedTo` — the content-root docName the href resolved to but which
 *   doesn't exist (`reason: 'no-such-doc'`), the content-root file path a
 *   link to an asset/source file resolved to but which isn't on disk
 *   (`reason: 'no-such-file'`, e.g. `src/foo.py`), or `null` when the href
 *   can't resolve at all (`reason: 'unresolvable'` — empty href, or a relative
 *   path that escapes the content root).
 */
export interface BrokenOutboundLink {
  href: string;
  resolvedTo: string | null;
  reason: BrokenLinkReason;
}

/**
 * Resolve a just-written doc's outbound internal links against the live set of
 * docs that exist, and return the ones that don't resolve. This is the
 * write-time validation primitive behind the `brokenLinks` response field.
 * It works **purely from the markdown bytes the write handler already
 * holds** — it does NOT read the BacklinkIndex (whose agent-write update is
 * 100ms-debounced and therefore stale at write-response time). It mirrors the
 * indexer's own link extraction (fence-aware, inline-code-aware, wiki +
 * markdown, `![[…]]` doc-embeds counted, external/anchor links skipped) so the
 * same links the graph tracks are the ones validated.
 *
 * Two existence oracles, because the two link kinds live in two different
 * places. **Doc links** (`.md`/`.mdx` / extensionless) are validated against
 * `admittedDocs` — the in-memory CRDT-doc set. **File links** (a markdown
 * `[text](path.ext)` to any non-doc file — a linked asset OR a source file like
 * `../src/foo.py`) have no CRDT presence, so they're validated against disk via
 * the injected `fileExists` oracle. This closes the gap where a wrong-depth
 * `../../../src/foo.py` 404s silently: `resolveAssetProjectPath` root-confines
 * the href (overshoot → `unresolvable`), then `fileExists` checks the resolved
 * path (missing → `no-such-file`). Omit `fileExists` and file links are skipped
 * (pure-resolution unit tests, callers without a filesystem). Wiki-link asset
 * embeds (`![[x.pdf]]`) are NOT validated — they resolve by vault-wide basename,
 * not by relative path, so the depth footgun doesn't apply and the path-pure
 * resolver here can't answer them.
 *
 * Wiki-link doc targets go through the shared composed resolution, so what
 * counts as existing here is what the editor actually navigates to. The report
 * this retracts is the bare name: `[[analysis]]` reaching `research/analysis`
 * by basename was flagged broken while the reader clicked it and arrived. A
 * dotted name now reaches that same chain instead of being read as a file
 * extension, though its verdict here is unchanged either way — a name that
 * promotes has by definition resolved, and one that doesn't stays silent like
 * any other asset. That asymmetry is the safety property: this can only ever
 * retract a report, never add one.
 *
 * Marginal cost is one doc's extraction + one `Set.has` (docs) or one
 * `fileExists` call (files) per distinct outbound link. A wiki target that
 * misses on exact name additionally builds the slug and basename maps — once
 * per call, memoized, never per link. Duplicate raw hrefs collapse to a single
 * entry.
 *
 * @param markdown        the full just-written source (frontmatter is stripped here)
 * @param sourceDocName   the doc being written (relative hrefs resolve against its dir)
 * @param admittedDocs    every docName that currently exists (the same admitted set `getDeadLinks` takes)
 * @param fileExists      oracle for a content-root-relative file path's on-disk existence; omit to skip file-link validation
 * @param folderExists    oracle for a content-root-relative folder path's existence; a link
 *                        naming an existing folder is a navigable destination (the folder
 *                        view), not a broken link. Omit to treat folders as unknown.
 */
export function computeBrokenOutboundLinks(
  markdown: string,
  sourceDocName: string,
  admittedDocs: Iterable<string>,
  fileExists?: (contentRootRelativePath: string) => boolean,
  folderExists?: (folderPath: string) => boolean,
): BrokenOutboundLink[] {
  const admitted = admittedDocs instanceof Set ? admittedDocs : new Set(admittedDocs);

  let body: string;
  try {
    ({ body } = stripFrontmatter(markdown));
  } catch {
    body = markdown;
  }

  const source = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = source.split('\n');
  const broken: BrokenOutboundLink[] = [];
  const seen = new Set<string>();
  let fence: FenceState | null = null;

  const record = (href: string, resolvedTo: string | null, reason: BrokenLinkReason): void => {
    if (seen.has(href)) return;
    seen.add(href);
    broken.push({ href, resolvedTo, reason });
  };

  const recordMarkdownLink = (rawHref: string): void => {
    const trimmed = rawHref.trim();
    // Pure anchor (`#section`) — an intra-doc reference, not a doc link.
    // Broken-anchor validation is deferred.
    if (trimmed.startsWith('#')) return;
    const classified = classifyMarkdownHref(trimmed, sourceDocName);
    if (!classified) {
      // Empty href, or a `.md`/`.mdx`/extensionless path that escapes the
      // content root: cannot resolve to any doc.
      record(trimmed, null, 'unresolvable');
      return;
    }
    if (classified.kind === 'doc') {
      // A path naming an existing folder is the folder view's destination —
      // the same exemption the dead-link audit applies.
      if (!admitted.has(classified.docName) && folderExists?.(classified.docName) !== true) {
        record(trimmed, classified.docName, 'no-such-doc');
      }
      return;
    }
    if (classified.kind === 'asset') {
      // A link to a non-doc file (a linked asset, or a source file like
      // `../src/foo.py`). It has no CRDT presence, so validate the resolved
      // path against disk. Skip when no oracle is injected.
      if (!fileExists) return;
      const filePath = resolveAssetProjectPath(classified.url, sourceDocName, {
        literal: classified.literal,
      });
      if (filePath === null) {
        // `../`-overshoot past the content root — the off-by-one depth bug.
        record(trimmed, null, 'unresolvable');
        return;
      }
      if (!fileExists(filePath)) {
        record(trimmed, filePath, 'no-such-file');
      }
      return;
    }
    // External URLs aren't a local link target — not our concern.
  };

  // Built on first read, not per call: the two maps cost a pass over the
  // admitted corpus each, and a body with no wiki links — or whose wiki links
  // all name their target exactly — never needs them, because
  // `resolveWikiLinkTargetDocName` tries `pages.has` before any map. Memoized,
  // so a body with many unresolved wiki links still builds each map once
  // rather than once per link.
  let pagesBySlug: ReadonlyMap<string, string> | undefined;
  let pagesByBasename: ReadonlyMap<string, string> | undefined;
  const wikiLookup: WikiLinkLookupIndex = {
    pages: admitted,
    get pagesBySlug() {
      pagesBySlug ??= buildPagesBySlugIndex(admitted, toWikiLinkSlug);
      return pagesBySlug;
    },
    get pagesByBasename() {
      pagesByBasename ??= buildPagesByBasenameIndex(admitted, toWikiLinkSlug);
      return pagesByBasename;
    },
  };

  const recordWikiLink = (target: string, anchor: string | null): void => {
    const resolved = resolveWikiLinkTarget(target, anchor, wikiLookup);
    // Only doc targets are validated. A target naming an asset — a `![[x.pdf]]`
    // embed, or a link to a tracked non-markdown file — resolves by vault-wide
    // basename rather than by relative path, so the depth footgun doesn't apply
    // and the path-pure resolver here can't answer it (unlike a markdown
    // `[text](path.ext)`, which IS file-validated above). A target naming
    // nothing stays classified as an asset and is therefore silent too, which
    // is what the dead-link query does with a recorded target that resolves to
    // nothing — reporting those would flood every vault that embeds assets.
    if (!resolved || resolved.kind !== 'doc') return;
    // Existence through the chain the editor navigates with, not an exact-key
    // hit. `[[analysis]]` reaching `research/analysis` by basename is a working
    // link, and the strict check reported exactly those as broken while staying
    // silent about the genuinely broken ones.
    if (
      resolveWikiLinkTargetDocName(resolved.docName, wikiLookup) === undefined &&
      folderExists?.(resolved.docName) !== true
    ) {
      record(`[[${target}${anchor ? `#${anchor}` : ''}]]`, resolved.docName, 'no-such-doc');
    }
  };

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const nextFence = matchFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }

    let idx = leadingMarkdownPrefixLength(line);
    while (idx < line.length) {
      if (line[idx] === '\\' && idx + 1 < line.length) {
        idx += 2;
        continue;
      }
      if (line[idx] === '`') {
        const inlineCode = readInlineCode(line, idx);
        if (inlineCode) {
          idx = inlineCode.nextIndex;
          continue;
        }
      }
      // Wiki form first, so `[[…]]` (and `![[…]]` doc-embeds) aren't re-read as
      // a markdown link — mirrors the indexer's extraction order.
      if (line[idx] === '[' && line[idx + 1] === '[') {
        const wikiLink = readWikiLink(line, idx);
        if (wikiLink) {
          recordWikiLink(wikiLink.target, wikiLink.anchor);
          idx = wikiLink.nextIndex;
          continue;
        }
      }
      if (line[idx] === '[' && line[idx - 1] !== '!') {
        const mdLink = readMarkdownLink(line, idx);
        if (mdLink) {
          recordMarkdownLink(mdLink.href);
          idx = mdLink.nextIndex;
          continue;
        }
      }
      idx++;
    }
  }

  return broken;
}

function serializeState(state: BranchGraphState): SerializedBranchGraphState {
  return {
    backward: Object.fromEntries(
      [...state.backward.entries()].map(([target, sources]) => [
        target,
        // `line`/`column` are undefined on entries carried over from a
        // pre-position cache; JSON.stringify drops them, so the on-disk shape
        // only ever holds real positions.
        [...sources.entries()].map(([source, meta]) => ({
          source,
          anchor: meta.anchor,
          snippet: meta.snippet,
          sourceForm: meta.sourceForm,
          line: meta.line,
          column: meta.column,
          // Persisted because it is not recoverable from the target string: a
          // markdown href can resolve to a docName that looks exactly like an
          // undecided wiki target (`notes/report.v2`). Losing it across a
          // restart would turn every asset embed into a dead link.
          ...(meta.rawWikiTarget === true ? { rawWikiTarget: true as const } : {}),
        })),
      ]),
    ),
    forward: Object.fromEntries(
      [...state.forward.entries()].map(([source, targets]) => [source, [...targets].sort()]),
    ),
    externalForward: Object.fromEntries(
      [...state.externalForward.entries()].map(([source, targets]) => [
        source,
        [...targets.entries()]
          .map(([url, meta]) => ({
            url,
            label: meta.label,
            snippet: meta.snippet,
          }))
          .sort((a, b) => a.url.localeCompare(b.url)),
      ]),
    ),
    skillRefs: Object.fromEntries(
      [...state.skillRefs.entries()].map(([source, names]) => [source, [...names].sort()]),
    ),
  };
}

function buildExternalBackward(
  externalForward: BranchGraphState['externalForward'],
): BranchGraphState['externalBackward'] {
  const externalBackward = new Map<
    string,
    Map<string, { label: string | null; snippet: string | null }>
  >();

  for (const [source, targets] of externalForward) {
    for (const [url, meta] of targets) {
      let sources = externalBackward.get(url);
      if (!sources) {
        sources = new Map();
        externalBackward.set(url, sources);
      }
      sources.set(source, meta);
    }
  }

  return externalBackward;
}

function cachePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function deserializeState(data: SerializedBranchGraphState): BranchGraphState {
  const externalForward = new Map(
    Object.entries(data.externalForward ?? {}).map(([source, targets]) => [
      source,
      new Map(
        targets.map((target) => [
          target.url,
          {
            label: target.label ?? null,
            snippet: target.snippet ?? null,
          },
        ]),
      ),
    ]),
  );

  return {
    backward: new Map(
      Object.entries(data.backward ?? {}).map(([target, entries]) => [
        target,
        new Map(
          entries.map((entry) => [
            entry.source,
            {
              anchor: entry.anchor ?? null,
              snippet: entry.snippet ?? null,
              sourceForm:
                entry.sourceForm === 'wiki' || entry.sourceForm === 'markdown'
                  ? entry.sourceForm
                  : undefined,
              // Cache files predating position indexing lack these fields, and
              // the cache is read without schema validation — admit non-negative
              // integers only (typeof alone lets -2 / 1.5 / NaN through to the
              // wire) so a stale/corrupt file degrades to "position unknown".
              line: cachePosition(entry.line),
              column: cachePosition(entry.column),
              rawWikiTarget: entry.rawWikiTarget === true,
            },
          ]),
        ),
      ]),
    ),
    forward: new Map(
      Object.entries(data.forward ?? {}).map(([source, targets]) => [source, new Set(targets)]),
    ),
    externalForward,
    externalBackward: buildExternalBackward(externalForward),
    skillRefs: new Map(
      Object.entries(data.skillRefs ?? {}).map(([source, names]) => [source, new Set(names)]),
    ),
    epoch: 0,
  };
}

/**
 * Every ancestor folder path of the given docNames — the server-side twin of
 * the client's `deriveKnownFolderPaths` (navigation-targets.ts). Used by
 * {@link BacklinkIndex.getDeadLinks} as the folder-existence oracle so a link
 * targeting an existing folder is never reported as a dead link.
 */
function deriveFolderPathsFromDocNames(docNames: Iterable<string>): Set<string> {
  const folderPaths = new Set<string>();
  for (const docName of docNames) {
    let slash = docName.indexOf('/');
    while (slash !== -1) {
      folderPaths.add(docName.slice(0, slash));
      slash = docName.indexOf('/', slash + 1);
    }
  }
  return folderPaths;
}

export class BacklinkIndex {
  private readonly projectDir: string;
  private readonly contentDir: string;
  private readonly contentFilter?: ContentFilter;
  private readonly getFileOracle: () => GraphFileOracle | undefined;
  private readonly states = new Map<string, BranchGraphState>();
  /**
   * Per-branch mtime snapshots. Populated by rebuildFromDisk / reconcileWithDisk
   * and persisted in the cache JSON. Used on the next startup to skip re-parsing
   * files whose mtime is unchanged.
   */
  private readonly mtimesByBranch = new Map<string, Map<string, number>>();
  /**
   * Cached slug/basename lookup per graph state, rebuilt only when that state's
   * `epoch` moves. Keyed by state object identity so a branch switch or a
   * snapshot reload (both of which install a fresh state) can never be served a
   * previous state's index.
   */
  private readonly documentLookups = new WeakMap<
    BranchGraphState,
    { epoch: number; lookup: WikiLinkLookupIndex }
  >();
  private activeBranch = 'main';

  constructor(options: BacklinkIndexOptions) {
    this.projectDir = options.projectDir;
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
    this.getFileOracle = options.getFileOracle ?? (() => undefined);
    this.states.set(this.activeBranch, createEmptyState());
  }

  private getState(branch = this.activeBranch): BranchGraphState {
    let state = this.states.get(branch);
    if (!state) {
      state = createEmptyState();
      this.states.set(branch, state);
    }
    return state;
  }

  /**
   * Structural graph neighbors of a skill bundle doc, derived from the doc NAME
   * shape (the shared skill-bundle parent) — not from any link the SKILL body
   * authored. A skill's `SKILL` doc connects to each indexed `references/**` doc
   * of the SAME skill, and vice versa. Additive to the authored wiki-link /
   * markdown-link edges and scoped strictly to skill bundles: a non-skill doc
   * returns no structural neighbors, so co-membership in a normal folder never
   * fabricates an edge.
   *
   * Both scopes participate with identical within-bundle semantics: PROJECT
   * bundles (content docs `.ok/skills/<name>/...`) and GLOBAL bundles
   * (managed-artifact docs `__skill__/global/<name>/...`). The match keys on the
   * scope-correct SKILL doc name (`skillDocName`), so a global SKILL pairs only
   * with global references of the same skill and a project SKILL only with
   * project references — never across the scope boundary, and a global reference
   * never connects into a project's KB.
   *
   * Membership is decided against the live node registry (`state.forward` holds a
   * key for every indexed doc, even one with zero authored links), so structural
   * edges appear and disappear as bundle docs are added / removed / renamed
   * without any extra bookkeeping.
   */
  private structuralBundleNeighbors(docName: string, branch = this.activeBranch): Set<string> {
    const parsed = parseSkillBundleDocAnyScope(docName);
    const neighbors = new Set<string>();
    if (!parsed) return neighbors;
    const state = this.getState(branch);
    // The doc itself must be a live node — a deleted bundle doc draws no edges,
    // so a partner left behind never reports the deleted doc as a neighbor.
    if (!state.forward.has(docName)) return neighbors;
    if (parsed.kind === 'skill') {
      // SKILL doc → every indexed reference doc whose own scope-correct SKILL
      // doc name equals this SKILL's name (same scope + same skill).
      for (const candidate of state.forward.keys()) {
        const other = parseSkillBundleDocAnyScope(candidate);
        if (other?.kind === 'reference' && other.skillDocName === docName) {
          neighbors.add(candidate);
        }
      }
    } else {
      // Reference doc → its skill's SKILL doc, when that SKILL doc is indexed.
      if (state.forward.has(parsed.skillDocName)) neighbors.add(parsed.skillDocName);
    }
    return neighbors;
  }

  /**
   * Skill-REFERENCE neighbors of a skill bundle doc: edges drawn from the
   * `/skill-name` tokens its body authors (the cross-agent invocation
   * convention the editor renders as chips) to the referenced skill's SKILL
   * doc. Same read-time-resolution model as `structuralBundleNeighbors` — the
   * recorded ref NAMES resolve against the live node registry on every query,
   * so the edge appears the moment the referenced skill is indexed and
   * disappears with it, no re-parse of the referencing doc needed.
   *
   * Scope-symmetric and SAME-SCOPE ONLY (both directions), mirroring the
   * structural-edge rule and the editor's same-scope reference picker: a
   * project skill's `/name` resolves to the project bundle, a global skill's
   * to `__skill__/global/<name>/SKILL` — never across the boundary, so a
   * global bundle still never links into a project's KB.
   */
  private skillRefNeighbors(docName: string, branch = this.activeBranch): Set<string> {
    const neighbors = new Set<string>();
    const state = this.getState(branch);
    if (!state.forward.has(docName)) return neighbors;
    const parsed = parseSkillBundleDocAnyScope(docName);
    if (!parsed) return neighbors;
    const globalScope = docName.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL);
    // OUTGOING: this doc's authored refs → each referenced skill's SKILL doc.
    const refs = state.skillRefs.get(docName);
    if (refs) {
      for (const ref of refs) {
        if (ref === parsed.name) continue; // self-reference draws no edge
        if (globalScope) {
          const target = skillLiveDocName('global', ref);
          if (state.forward.has(target)) neighbors.add(target);
        } else {
          for (const candidate of state.forward.keys()) {
            const other = parseSkillBundleDocAnyScope(candidate);
            if (
              other?.kind === 'skill' &&
              other.name === ref &&
              !candidate.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL)
            ) {
              neighbors.add(candidate);
            }
          }
        }
      }
    }
    // INCOMING: only a SKILL doc is a ref target; every same-scope bundle doc
    // whose recorded refs name this skill draws the reverse edge.
    if (parsed.kind === 'skill') {
      for (const [source, names] of state.skillRefs) {
        if (source === docName || !names.has(parsed.name)) continue;
        if (source.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL) !== globalScope) continue;
        if (state.forward.has(source)) neighbors.add(source);
      }
    }
    return neighbors;
  }

  /** Union of the two derived (non-authored) edge families of a skill bundle
   *  doc: structural within-bundle partners + `/skill-name` reference edges.
   *  The single seam every read path (backlinks, forward links, graph
   *  traversal) uses, so the two families can never diverge per surface. */
  private bundleNeighbors(docName: string, branch = this.activeBranch): Set<string> {
    const neighbors = this.structuralBundleNeighbors(docName, branch);
    for (const n of this.skillRefNeighbors(docName, branch)) neighbors.add(n);
    return neighbors;
  }

  /** Record (or clear) the `/skill-name` ref tokens a skill bundle doc's body
   *  authors. No-op for non-bundle docs — plain prose mentioning `/tmp`-style
   *  tokens must never fabricate graph edges. */
  private recordSkillRefs(docName: string, body: string, branch = this.activeBranch): void {
    this.recordSkillRefsInto(this.getState(branch), docName, body);
  }

  /**
   * State-explicit twin of {@link recordSkillRefs}. The cold rebuild builds a
   * detached state and only installs it at the end, so it cannot go through
   * `getState(branch)` — it would write refs into the state it is replacing.
   * Both paths share this one implementation so the rule cannot drift; a
   * rebuild that skipped it left every project skill's `/skill-name` edges
   * missing while global bundles (re-ingested per boot) looked fine.
   */
  private recordSkillRefsInto(state: BranchGraphState, docName: string, body: string): void {
    if (!parseSkillBundleDocAnyScope(docName)) return;
    const refs = extractSkillRefs(body);
    if (refs.length === 0) state.skillRefs.delete(docName);
    else state.skillRefs.set(docName, new Set(refs));
  }

  getActiveBranch(): string {
    return this.activeBranch;
  }

  switchBranch(branch: string): void {
    this.activeBranch = branch;
    this.getState(branch);
  }

  private cachePath(branch = this.activeBranch): string {
    return resolve(getLocalDir(this.projectDir), 'cache', branch, 'backlinks.json');
  }

  /**
   * Register `docName` as a live graph node carrying NO authored link edges,
   * dropping any prior authored edges it had. Idempotent. Used for GLOBAL skill
   * bundle docs: they get structural (name-derived) within-bundle edges to their
   * own SKILL / references, but their body is deliberately NOT parsed for
   * wiki/markdown links — a global skill must never link into a project's KB
   * (within-bundle-only). A bare node also gives `structuralBundleNeighbors` a
   * live endpoint so the structural edge actually draws.
   */
  private registerNodeOnly(docName: string, branch = this.activeBranch): void {
    const state = this.getState(branch);
    const priorTargets = state.forward.get(docName) ?? new Set<string>();
    const priorExternalTargets = state.externalForward.get(docName) ?? new Map();
    for (const target of priorTargets) {
      const sources = state.backward.get(target);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.backward.delete(target);
    }
    for (const url of priorExternalTargets.keys()) {
      const sources = state.externalBackward.get(url);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.externalBackward.delete(url);
    }
    state.forward.set(docName, new Set());
    state.epoch++;
    state.externalForward.set(docName, new Map());
  }

  /**
   * Public node-only registration for a GLOBAL skill bundle doc (SKILL or
   * reference). Ingestion (boot scan + the managed-artifact watcher) calls this
   * so a global bundle's nodes exist as structural-edge endpoints WITHOUT pulling
   * their body into cross-KB link parsing. A non-global-bundle name is ignored
   * (this method is the ONLY supported way to add a global bundle node).
   */
  registerGlobalSkillBundleNode(docName: string, branch = this.activeBranch): void {
    if (!parseGlobalSkillBundleDoc(docName)) return;
    this.registerNodeOnly(docName, branch);
  }

  updateDocument(
    docName: string,
    links: ExtractedWikiLink[],
    externalLinks: ExtractedExternalLink[] = [],
    branch = this.activeBranch,
  ): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    // Global skill bundle docs participate via structural edges ONLY — never
    // ingest their authored body links (a global reference's `[[project-doc]]`
    // must NOT create a cross-boundary edge into this project's KB). Register the
    // node and stop; deleteDocument still removes it like any other node.
    if (parseGlobalSkillBundleDoc(docName)) {
      this.registerNodeOnly(docName, branch);
      return;
    }
    const state = this.getState(branch);
    const priorTargets = state.forward.get(docName) ?? new Set<string>();
    const priorExternalTargets = state.externalForward.get(docName) ?? new Map();

    for (const target of priorTargets) {
      const sources = state.backward.get(target);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.backward.delete(target);
    }

    for (const url of priorExternalTargets.keys()) {
      const sources = state.externalBackward.get(url);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.externalBackward.delete(url);
    }

    const nextTargets = new Set<string>();
    const nextExternalTargets = new Map<string, { label: string | null; snippet: string | null }>();
    state.forward.set(docName, nextTargets);
    state.epoch++;
    state.externalForward.set(docName, nextExternalTargets);

    for (const link of links) {
      if (!link.target) continue;
      nextTargets.add(link.target);
      let sources = state.backward.get(link.target);
      if (!sources) {
        sources = new Map();
        state.backward.set(link.target, sources);
      }
      sources.set(
        docName,
        mergeLinkMeta(sources.get(docName), {
          anchor: link.anchor,
          snippet: link.snippet,
          sourceForm: link.sourceForm,
          line: link.line,
          column: link.column,
          rawWikiTarget: link.rawWikiTarget === true,
        }),
      );
    }

    for (const link of externalLinks) {
      if (!link.url) continue;
      nextExternalTargets.set(link.url, {
        label: link.label,
        snippet: link.snippet,
      });
      let sources = state.externalBackward.get(link.url);
      if (!sources) {
        sources = new Map();
        state.externalBackward.set(link.url, sources);
      }
      if (!sources.has(docName) || (!sources.get(docName)?.snippet && link.snippet)) {
        sources.set(docName, {
          label: link.label,
          snippet: link.snippet,
        });
      }
    }
  }

  updateDocumentFromMarkdown(docName: string, markdown: string, branch = this.activeBranch): void {
    try {
      const { frontmatter, body } = stripFrontmatter(markdown);
      const lineOffset = frontmatterLineCount(frontmatter);
      const wikiLinks = extractWikiLinksFromMarkdown(body, docName, lineOffset).map((link) => ({
        ...link,
        sourceForm: 'wiki' as const,
      }));
      const mdLinks = extractMarkdownLinksFromMarkdown(
        body,
        docName,
        lineOffset,
        this.getFileOracle(),
      ).map((link) => ({ ...link, sourceForm: 'markdown' as const }));
      const wikiExternalLinks = extractExternalWikiLinksFromMarkdown(body);
      const mdExternalLinks = extractExternalMarkdownLinksFromMarkdown(body, docName);
      // Merge: wiki links take precedence for duplicate targets (they have richer snippet context)
      const seen = new Set(wikiLinks.map((l) => l.target));
      const merged = [...wikiLinks, ...mdLinks.filter((l) => !seen.has(l.target))];
      const externalSeen = new Set(wikiExternalLinks.map((l) => l.url));
      const mergedExternal = [
        ...wikiExternalLinks,
        ...mdExternalLinks.filter((link) => !externalSeen.has(link.url)),
      ];
      this.recordSkillRefs(docName, body, branch);
      this.updateDocument(docName, merged, mergedExternal, branch);
    } catch (err) {
      log.warn({ docName, err }, `Failed to scan ${docName} for link extraction`);
      this.deleteDocument(docName, branch);
    }
  }

  deleteDocument(docName: string, branch = this.activeBranch): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    const state = this.getState(branch);
    const targets = state.forward.get(docName) ?? new Set<string>();
    const externalTargets = state.externalForward.get(docName) ?? new Map();
    for (const target of targets) {
      const sources = state.backward.get(target);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.backward.delete(target);
    }
    for (const url of externalTargets.keys()) {
      const sources = state.externalBackward.get(url);
      if (!sources) continue;
      sources.delete(docName);
      if (sources.size === 0) state.externalBackward.delete(url);
    }
    state.forward.delete(docName);
    state.epoch++;
    state.externalForward.delete(docName);
    state.skillRefs.delete(docName);
  }

  renameDocument(
    oldDocName: string,
    newDocName: string,
    markdown: string,
    branch = this.activeBranch,
  ): void {
    this.deleteDocument(oldDocName, branch);
    this.updateDocumentFromMarkdown(newDocName, markdown, branch);
  }

  getBacklinks(target: string, branch = this.activeBranch): BacklinkEntry[] {
    const state = this.getState(branch);
    const sources = state.backward.get(target);
    const entries = new Map<string, BacklinkEntry>();
    if (sources) {
      for (const [source, meta] of sources) {
        entries.set(source, { source, anchor: meta.anchor, snippet: meta.snippet });
      }
    }
    // Structural skill-bundle edges are undirected, so a SKILL↔reference partner
    // is a backlink source even when neither doc authored a link to the other.
    for (const partner of this.bundleNeighbors(target, branch)) {
      if (!entries.has(partner))
        entries.set(partner, { source: partner, anchor: null, snippet: null });
    }
    return [...entries.values()].sort((a, b) => a.source.localeCompare(b.source));
  }

  /**
   * Backlink count without materializing the entry list — cheap primitive for
   * bulk/listing UIs that need connection density but not sources/snippets.
   * O(1) for ordinary docs; a SKILL/reference doc additionally unions its
   * structural skill-bundle partners (`structuralBundleNeighbors` scans the
   * forward map), so the count stays consistent with `getBacklinks`.
   */
  getBacklinkCount(target: string, branch = this.activeBranch): number {
    const state = this.getState(branch);
    const authored = state.backward.get(target);
    const structural = this.bundleNeighbors(target, branch);
    if (structural.size === 0) return authored?.size ?? 0;
    const union = new Set(authored?.keys() ?? []);
    for (const partner of structural) union.add(partner);
    return union.size;
  }

  getForwardLinks(source: string, branch = this.activeBranch): string[] {
    const state = this.getState(branch);
    const targets = new Set(state.forward.get(source) ?? new Set<string>());
    // Undirected structural skill-bundle edges surface as forward links too, so a
    // SKILL doc lists its references (and a reference lists its SKILL) even with
    // no authored link between them.
    for (const partner of this.bundleNeighbors(source, branch)) targets.add(partner);
    return [...targets].sort((a, b) => a.localeCompare(b));
  }

  getForwardLinkEntries(source: string, branch = this.activeBranch): ForwardLinkEntry[] {
    const state = this.getState(branch);
    const internalEntries: ForwardLinkEntry[] = this.getForwardLinks(source, branch).map(
      (target) => ({
        kind: 'doc',
        target,
        anchor: state.backward.get(target)?.get(source)?.anchor ?? null,
        snippet: state.backward.get(target)?.get(source)?.snippet ?? null,
      }),
    );
    const externalEntries: ForwardLinkEntry[] = [
      ...(state.externalForward.get(source) ?? new Map()).entries(),
    ]
      .map(([url, meta]) => ({
        kind: 'external' as const,
        url,
        label: meta.label,
        snippet: meta.snippet,
      }))
      .sort((a, b) => a.url.localeCompare(b.url));
    return [...internalEntries, ...externalEntries];
  }

  getOrphans(allDocs: string[], mode: OrphanMode = 'both', branch = this.activeBranch): string[] {
    const state = this.getState(branch);
    // Precompute the set of SKILL docs that have ≥1 indexed reference in ONE
    // pass over the forward index. Otherwise the per-doc structural-edge check
    // below calls `structuralBundleNeighbors`, which re-scans every forward key
    // for each SKILL doc — O(skills × docs) overall. This mirrors the existence
    // semantics of `structuralBundleNeighbors` (keep in sync if that changes).
    const skillDocsWithReference = new Set<string>();
    for (const candidate of state.forward.keys()) {
      const parsed = parseSkillBundleDocAnyScope(candidate);
      if (parsed?.kind === 'reference') skillDocsWithReference.add(parsed.skillDocName);
    }
    const hasStructuralEdge = (docName: string): boolean => {
      const parsed = parseSkillBundleDocAnyScope(docName);
      // A deleted bundle doc (not a live forward node) draws no edges.
      if (!parsed || !state.forward.has(docName)) return false;
      return parsed.kind === 'skill'
        ? skillDocsWithReference.has(docName)
        : state.forward.has(parsed.skillDocName);
    };
    return [...allDocs]
      .filter((docName) => {
        // Structural skill-bundle edges are undirected, so a partner counts as
        // both an inbound and an outbound edge — a connected reference is not an
        // orphan even with zero authored links.
        const structural = hasStructuralEdge(docName);
        const hasInboundEdges = structural || (state.backward.get(docName)?.size ?? 0) > 0;
        const hasOutboundEdges = structural || (state.forward.get(docName)?.size ?? 0) > 0;

        if (mode === 'incoming') return !hasInboundEdges;
        if (mode === 'outgoing') return !hasOutboundEdges;
        return !hasInboundEdges && !hasOutboundEdges;
      })
      .sort((a, b) => a.localeCompare(b));
  }

  getHubs(limit = 20, branch = this.activeBranch): HubEntry[] {
    const state = this.getState(branch);
    return [...state.backward.entries()]
      .map(([docName, sources]) => ({ docName, count: sources.size }))
      .sort((a, b) =>
        b.count === a.count ? a.docName.localeCompare(b.docName) : b.count - a.count,
      )
      .slice(0, limit);
  }

  /**
   * Every docName the graph has indexed — one key per doc whose body passed
   * through `updateDocument`, even a doc with zero outbound links. This is the
   * additive existence oracle the dead-link check folds in (see `getDeadLinks`):
   * `state.forward` is updated in-process by `onStoreDocument`, so it holds a
   * just-persisted doc immediately, ahead of the async file-watcher index.
   * Callers union this with their file-index view so file-index lag (or a
   * dropped FSEvent) never demotes a live graph node to "missing". A referenced-
   * but-missing target is never a forward node (it lives only in `state.backward`),
   * so this set never reports a non-existent doc as existing.
   */
  getIndexedDocNames(branch = this.activeBranch): string[] {
    return [...this.getState(branch).forward.keys()];
  }

  /**
   * Referenced targets that don't resolve to an existing doc. Existence is
   * `admittedDocs ∪ keys(state.forward)`, NOT `admittedDocs` alone: `state.forward`
   * is an additive second oracle (every doc whose body the graph has indexed),
   * so a narrower admitted set never demotes a live graph node to "missing".
   * See the inline note on the existence check for why this keeps dead-link and
   * backlink resolution in agreement.
   */
  getDeadLinks(
    admittedDocs: Iterable<string>,
    sourceDocNames?: readonly string[],
    branch = this.activeBranch,
    knownFolderPaths?: Iterable<string>,
  ): DeadLinkEntry[] {
    const state = this.getState(branch);
    const admittedDocSet = new Set(admittedDocs);
    const sourceDocSet = sourceDocNames?.length ? new Set(sourceDocNames) : null;
    // Folder-existence oracle: a link to an existing folder is a real
    // destination — the editor resolves it to the 'folder' display state and
    // clicking opens the folder view at `#/<folderPath>` — so reporting it
    // dead contradicts every navigating surface. Two sources, unioned to
    // match the client's own union (`deriveKnownFolderPaths(pages)` ∪ the
    // watcher folder index in PageListContext): the ancestors of every
    // existing doc (covers CRDT-live docs the watcher has not indexed yet)
    // plus the caller-provided watcher folder inventory (covers empty and
    // asset-only folders, which have no doc descendants to derive from).
    const folderPathSet = deriveFolderPathsFromDocNames([
      ...admittedDocSet,
      ...state.forward.keys(),
    ]);
    for (const folderPath of knownFolderPaths ?? []) folderPathSet.add(folderPath);

    return [...state.backward.entries()]
      .filter(([target, sources]) => {
        // A target exists if the caller's admitted set lists it OR the graph
        // already holds it as a live forward node. `state.forward` gains a key
        // the moment a doc's body is indexed (the same `updateDocument` call
        // that records this backlink edge), so a freshly-written doc is a valid
        // target immediately — even before the async file-watcher adds it to
        // `admittedDocs`. Without the forward check the two indexes disagree: a
        // doc the graph just registered a backlink FOR gets reported dead until
        // the watcher re-indexes (or the server restarts). A genuinely-missing
        // target is never a forward node (only `state.backward` carries it), so
        // this never hides a real dead link.
        if (admittedDocSet.has(target) || state.forward.has(target)) return false;
        // A target naming an existing folder is navigable, not dead — every
        // occurrence form (wiki AND markdown path) resolves it to the folder
        // view, so the exemption is form-agnostic. Exact membership only; no
        // slug/basename fuzz, so a path naming nothing still reports dead.
        if (folderPathSet.has(target.replace(/\/+$/, ''))) return false;
        if (!sourceDocSet) return sources.size > 0;
        for (const source of sources.keys()) {
          if (sourceDocSet.has(source)) return true;
        }
        return false;
      })
      .map(([target, sources]) => ({
        target,
        sources: [...sources.entries()]
          // An undecided raw wiki occurrence is never evidence of a broken
          // link. It either names a document the corpus knows under another
          // spelling (`[[acp.daemon]]` → `notes/acp.daemon.md`), or it names
          // nothing the graph can see — an asset embed, a tracked non-markdown
          // file — and then it stays silent exactly as it did when index time
          // discarded it outright. Reporting that second class is the
          // regression this filter exists to avoid: every vault that embeds an
          // asset would fill with dead links. A target left with no decided
          // occurrence drops out below.
          .filter(([, meta]) => meta.rawWikiTarget !== true)
          // The existence test above compares literal names, but a wiki target
          // reaches its document through the whole chain — slug, folder index,
          // basename. Without this, `[[analysis]]` naming `research/analysis`
          // is reported broken while clicking it arrives, which is the
          // contradiction between the audit and the editor that this work
          // exists to remove. Markdown hrefs are deliberately excluded: they
          // are paths, and no surface basename-resolves them, so relaxing them
          // here would hide genuinely wrong ones. Membership is what makes this
          // safe to apply — a target naming nothing still resolves to
          // `undefined` and is still reported.
          .filter(
            ([, meta]) =>
              meta.sourceForm !== 'wiki' ||
              resolveWikiLinkTargetDocName(target, this.documentLookup(branch)) === undefined,
          )
          .filter(([source]) => !sourceDocSet || sourceDocSet.has(source))
          .map(([source, meta]) => ({
            source,
            anchor: meta.anchor,
            snippet: meta.snippet,
            sourceForm: meta.sourceForm,
            line: meta.line,
            column: meta.column,
          }))
          .sort((a, b) => a.source.localeCompare(b.source)),
      }))
      .filter((entry) => entry.sources.length > 0)
      .sort((a, b) =>
        b.sources.length === a.sources.length
          ? a.target.localeCompare(b.target)
          : b.sources.length - a.sources.length,
      );
  }

  /**
   * The document set query-time wiki-link resolution runs against: every doc the
   * graph has indexed. Built once per {@link BranchGraphState.epoch} and reused,
   * so a scan over many targets pays for it once.
   */
  private documentLookup(branch = this.activeBranch): WikiLinkLookupIndex {
    const state = this.getState(branch);
    const cached = this.documentLookups.get(state);
    if (cached?.epoch === state.epoch) return cached.lookup;

    const pages = new Set(state.forward.keys());
    const lookup: WikiLinkLookupIndex = {
      pages,
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
      pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
    };
    this.documentLookups.set(state, { epoch: state.epoch, lookup });
    return lookup;
  }

  /**
   * Whether an undecided raw wiki target names a real document after all. The
   * shared resolver owns the rule — asset first, document membership only when
   * no asset matches — so the graph and the editor promote the same targets.
   * The graph has no asset oracle, so anything that isn't a document here stays
   * an asset and is dropped rather than minted as a node.
   */
  private undecidedTargetResolves(target: string, branch = this.activeBranch): boolean {
    return resolveWikiLinkTarget(target, null, this.documentLookup(branch))?.kind === 'doc';
  }

  getLinkGraph(branch = this.activeBranch): {
    nodes: GraphNode[];
    links: Array<{ source: string; target: string }>;
  } {
    const state = this.getState(branch);
    const nodes = new Map<string, GraphNode>();
    const links: Array<{ source: string; target: string }> = [];

    for (const [source, targets] of state.forward) {
      nodes.set(source, {
        kind: 'doc',
        id: source,
        docName: source,
        anchor: getRepresentativeAnchor(state.backward.get(source)),
      });
      for (const target of targets) {
        // An asset embed (`![[diagram.png]]`) is recorded like any other wiki
        // target but names no document, and minting a node for it would put a
        // phantom doc in the graph for every asset a vault embeds.
        if (isUndecidedTarget(state, target) && !this.undecidedTargetResolves(target, branch)) {
          continue;
        }
        nodes.set(target, {
          kind: 'doc',
          id: target,
          docName: target,
          anchor: getRepresentativeAnchor(state.backward.get(target)),
        });
        links.push({ source, target });
      }
    }

    for (const [source, targets] of state.externalForward) {
      nodes.set(source, {
        kind: 'doc',
        id: source,
        docName: source,
        anchor: getRepresentativeAnchor(state.backward.get(source)),
      });
      for (const [url, meta] of targets) {
        const id = externalNodeId(url);
        nodes.set(id, { kind: 'external', id, url, label: meta.label });
        links.push({ source, target: id });
      }
    }

    // Structural skill-bundle edges (SKILL → references of the same skill).
    // Emitted directionally SKILL→reference, skipping any pair an authored link
    // already covers (in EITHER direction) so a wiki-link ref isn't double-drawn.
    for (const source of state.forward.keys()) {
      const parsed = parseSkillBundleDocAnyScope(source);
      if (parsed?.kind !== 'skill') continue;
      for (const target of this.bundleNeighbors(source, branch)) {
        if (state.forward.get(source)?.has(target) || state.forward.get(target)?.has(source)) {
          continue;
        }
        nodes.set(source, {
          kind: 'doc',
          id: source,
          docName: source,
          anchor: getRepresentativeAnchor(state.backward.get(source)),
        });
        nodes.set(target, {
          kind: 'doc',
          id: target,
          docName: target,
          anchor: getRepresentativeAnchor(state.backward.get(target)),
        });
        links.push({ source, target });
      }
    }

    return {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      links,
    };
  }

  getLinkGraphNeighborhood(
    centerDocName: string,
    maxDegrees: number,
    branch = this.activeBranch,
  ): {
    nodes: GraphNode[];
    links: Array<{ source: string; target: string }>;
  } {
    const state = this.getState(branch);
    const externalLabelsByUrl = new Map<string, string | null>();
    for (const targets of state.externalForward.values()) {
      for (const [url, meta] of targets) {
        if (!externalLabelsByUrl.has(url)) {
          externalLabelsByUrl.set(url, meta.label);
        }
      }
    }
    const visited = new Set<string>([centerDocName]);
    const queue: Array<{ nodeId: string; degree: number }> = [{ nodeId: centerDocName, degree: 0 }];
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (current.degree >= maxDegrees) continue;

      const currentExternalUrl = externalUrlFromNodeId(current.nodeId);
      const neighbors = new Set<string>();

      if (currentExternalUrl) {
        for (const source of state.externalBackward.get(currentExternalUrl)?.keys() ?? []) {
          neighbors.add(source);
        }
      } else {
        for (const target of state.forward.get(current.nodeId) ?? new Set<string>()) {
          // Same admission the whole-graph view applies. Recording every wiki
          // target verbatim means an asset embed reaches here as an ordinary
          // target, and without this the neighborhood mints a document node
          // the whole graph suppresses — two views of one graph disagreeing
          // about which documents exist. Traversal is the right place for it:
          // an unadmitted target never enters `visited`, so it can't return as
          // a node or as an edge endpoint below.
          if (isUndecidedTarget(state, target) && !this.undecidedTargetResolves(target, branch)) {
            continue;
          }
          neighbors.add(target);
        }
        for (const url of state.externalForward.get(current.nodeId)?.keys() ?? []) {
          neighbors.add(externalNodeId(url));
        }
        for (const source of state.backward.get(current.nodeId)?.keys() ?? []) {
          neighbors.add(source);
        }
        // Structural skill-bundle partners are undirected neighbors for traversal.
        for (const partner of this.bundleNeighbors(current.nodeId, branch)) {
          neighbors.add(partner);
        }
      }

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ nodeId: neighbor, degree: current.degree + 1 });
      }
    }

    const links: Array<{ source: string; target: string }> = [];
    for (const [source, targets] of state.forward) {
      if (!visited.has(source)) continue;
      for (const target of targets) {
        if (!visited.has(target)) continue;
        links.push({ source, target });
      }
    }

    for (const [source, targets] of state.externalForward) {
      if (!visited.has(source)) continue;
      for (const url of targets.keys()) {
        const id = externalNodeId(url);
        if (!visited.has(id)) continue;
        links.push({ source, target: id });
      }
    }

    // Structural skill-bundle edges, directional SKILL→reference, both visited.
    // Skip any pair an authored link already covers (either direction) so a
    // wiki-link ref isn't double-drawn.
    for (const source of visited) {
      const parsed = parseSkillBundleDocAnyScope(source);
      if (parsed?.kind !== 'skill') continue;
      for (const target of this.bundleNeighbors(source, branch)) {
        if (!visited.has(target)) continue;
        if (state.forward.get(source)?.has(target) || state.forward.get(target)?.has(source)) {
          continue;
        }
        links.push({ source, target });
      }
    }

    const nodes = [...visited].sort().map<GraphNode>((nodeId) => {
      const url = externalUrlFromNodeId(nodeId);
      if (!url) {
        return {
          kind: 'doc',
          id: nodeId,
          docName: nodeId,
          anchor: getRepresentativeAnchor(state.backward.get(nodeId)),
        };
      }
      return {
        kind: 'external',
        id: nodeId,
        url,
        label: externalLabelsByUrl.get(url) ?? null,
      };
    });

    return { nodes, links };
  }

  async saveToDisk(branch = this.activeBranch): Promise<void> {
    const filePath = this.cachePath(branch);
    mkdirSync(dirname(filePath), { recursive: true });
    const state = this.getState(branch);
    const mtimes = this.mtimesByBranch.get(branch);
    const data: SerializedBranchGraphState = {
      version: SNAPSHOT_VERSION,
      ...serializeState(state),
      ...(mtimes ? { mtimes: Object.fromEntries(mtimes) } : {}),
    };
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // A version mismatch (or a versionless pre-SNAPSHOT_VERSION cache) rejects
  // the load so the caller cold-rebuilds. The mtime reconcile that follows a
  // successful load re-parses only CHANGED docs, so it cannot heal a stale key
  // written under a retired link-target format — see SNAPSHOT_VERSION.
  async loadFromDisk(branch = this.activeBranch): Promise<boolean> {
    const filePath = this.cachePath(branch);
    if (!existsSync(filePath)) return false;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SerializedBranchGraphState;
      if (parsed.version !== SNAPSHOT_VERSION) return false;
      this.states.set(branch, deserializeState(parsed));
      if (parsed.mtimes) {
        this.mtimesByBranch.set(branch, new Map(Object.entries(parsed.mtimes)));
      } else {
        this.mtimesByBranch.delete(branch);
      }
      return true;
    } catch (err) {
      log.warn({ branch, err }, `Failed to load cache for ${branch}`);
      return false;
    }
  }

  clear(branch = this.activeBranch): void {
    this.states.set(branch, createEmptyState());
    this.mtimesByBranch.delete(branch);
  }

  /**
   * Full cold-start rebuild. Reads and parses every .md/.mdx in the content
   * tree. Async with bounded concurrency (50 files per batch) so the event loop
   * is not blocked for the duration. Collects mtime snapshots so the next boot
   * can use reconcileWithDisk() instead.
   *
   * Uses `walkForPaths` (which threads the observed on-disk extension) so the
   * rebuild does not depend on the file-watcher's `docExtensionByName`
   * registry being populated. Boot order calls this BEFORE `startWatcher`, so
   * the registry is empty at this point; a `getDocExtension`-based path would
   * default every docName to `.md` — ENOENT on every `.mdx`. The sibling
   * `reconcileWithDisk` path takes the same shape.
   */
  async rebuildFromDisk(branch = this.activeBranch): Promise<void> {
    return instrumentIndexRebuild('backlink', 'full', () => this.rebuildFromDiskUnspanned(branch));
  }

  private async rebuildFromDiskUnspanned(branch: string): Promise<void> {
    const state = createEmptyState();
    const mtimes = new Map<string, number>();
    const rawDocs: Array<{ docName: string; filePath: string }> = [];
    await this.walkForPaths(this.contentDir, rawDocs);

    const seen = new Set<string>();
    const allDocs = rawDocs.filter(({ docName }) => {
      if (seen.has(docName)) return false;
      seen.add(docName);
      return true;
    });

    const BATCH_SIZE = 50;
    for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
      const batch = allDocs.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ docName, filePath }) => {
          const [fileStat, markdown] = await Promise.all([
            stat(filePath),
            readFile(filePath, 'utf-8'),
          ]);
          return { docName, mtimeMs: fileStat.mtimeMs, markdown };
        }),
      );

      for (const result of settled) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason }, 'Failed to rebuild entry');
          continue;
        }
        const { docName, mtimeMs, markdown } = result.value;
        mtimes.set(docName, mtimeMs);
        const { frontmatter, body } = stripFrontmatter(markdown);
        const lineOffset = frontmatterLineCount(frontmatter);
        const wikiLinks = extractWikiLinksFromMarkdown(body, docName, lineOffset).map((link) => ({
          ...link,
          sourceForm: 'wiki' as const,
        }));
        const mdLinks = extractMarkdownLinksFromMarkdown(
          body,
          docName,
          lineOffset,
          this.getFileOracle(),
        ).map((link) => ({ ...link, sourceForm: 'markdown' as const }));
        const wikiExternalLinks = extractExternalWikiLinksFromMarkdown(body);
        const mdExternalLinks = extractExternalMarkdownLinksFromMarkdown(body, docName);
        const seen = new Set(wikiLinks.map((l) => l.target));
        const links = [...wikiLinks, ...mdLinks.filter((l) => !seen.has(l.target))];
        const externalSeen = new Set(wikiExternalLinks.map((l) => l.url));
        const externalLinks = [
          ...wikiExternalLinks,
          ...mdExternalLinks.filter((link) => !externalSeen.has(link.url)),
        ];
        const targets = new Set<string>();
        const externalTargets = new Map<string, { label: string | null; snippet: string | null }>();
        this.recordSkillRefsInto(state, docName, body);
        state.forward.set(docName, targets);
        state.epoch++;
        state.externalForward.set(docName, externalTargets);
        for (const link of links) {
          if (!link.target) continue;
          targets.add(link.target);
          let sources = state.backward.get(link.target);
          if (!sources) {
            sources = new Map();
            state.backward.set(link.target, sources);
          }
          sources.set(
            docName,
            mergeLinkMeta(sources.get(docName), {
              anchor: link.anchor,
              snippet: link.snippet,
              sourceForm: link.sourceForm,
              line: link.line,
              column: link.column,
              rawWikiTarget: link.rawWikiTarget === true,
            }),
          );
        }
        for (const link of externalLinks) {
          if (!link.url) continue;
          externalTargets.set(link.url, { label: link.label, snippet: link.snippet });
          let sources = state.externalBackward.get(link.url);
          if (!sources) {
            sources = new Map();
            state.externalBackward.set(link.url, sources);
          }
          sources.set(docName, { label: link.label, snippet: link.snippet });
        }
      }
    }

    this.states.set(branch, state);
    this.mtimesByBranch.set(branch, mtimes);
  }

  /**
   * Walk the content directory and return absolute file paths alongside their
   * docNames. Avoids getDocExtension() so reconcileWithDisk doesn't depend on
   * the file-watcher's extension registry being populated at startup.
   *
   * Async per-directory readdir so the event loop stays responsive during
   * boot on large content dirs (thousands of files) — a synchronous walk
   * blocks signal handlers and collab/API traffic until it completes.
   */
  private async walkForPaths(
    dir: string,
    results: Array<{ docName: string; filePath: string }>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn({ dir, err }, `Failed to read directory ${dir}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = toPosix(relative(this.contentDir, fullPath));
        if (this.contentFilter && relDir && this.contentFilter.isDirExcluded(relDir)) continue;
        await this.walkForPaths(fullPath, results);
      } else if (entry.isFile() && isSupportedDocFile(entry.name)) {
        const relPath = toPosix(relative(this.contentDir, fullPath));
        if (this.contentFilter?.isExcluded(relPath)) continue;
        results.push({ docName: stripDocExtension(relPath), filePath: fullPath });
      }
    }
  }

  /**
   * Incremental startup reconcile. Compares per-file mtimes against the snapshot
   * persisted in the cache, re-parsing only files that changed while the server
   * was offline. Requires the cache to have been loaded via loadFromDisk() first.
   *
   * Falls back to a full entry update for any file whose mtime differs, and
   * removes entries for files that no longer exist on disk.
   *
   * Returns counts of changed files for diagnostic logging.
   */
  async reconcileWithDisk(branch = this.activeBranch): Promise<{
    added: number;
    updated: number;
    deleted: number;
    /**
     * DocNames dropped because their file is gone from disk (global skill
     * bundle nodes excluded — they live outside contentDir). Includes docs
     * known only via graph keys, not just the mtime snapshot: docs created
     * since the last full rebuild/reconcile have graph entries but no
     * snapshot entry. Feeds the boot-time deleted-while-down tombstoning,
     * which applies its own doc-kind filters at the populate site.
     */
    deletedDocNames: string[];
  }> {
    return instrumentIndexRebuild(
      'backlink',
      'reconcile',
      () => this.reconcileWithDiskUnspanned(branch),
      (diff) => ({
        'index.added': diff.added,
        'index.updated': diff.updated,
        'index.deleted': diff.deleted,
      }),
    );
  }

  private async reconcileWithDiskUnspanned(branch: string): Promise<{
    added: number;
    updated: number;
    deleted: number;
    deletedDocNames: string[];
  }> {
    if (!existsSync(this.contentDir))
      return { added: 0, updated: 0, deleted: 0, deletedDocNames: [] };

    const storedMtimes = this.mtimesByBranch.get(branch) ?? new Map<string, number>();
    const rawDocs: Array<{ docName: string; filePath: string }> = [];
    await this.walkForPaths(this.contentDir, rawDocs);

    // Deduplicate: foo.md and foo.mdx both strip to "foo"; keep first occurrence
    // (same first-wins dedup as rebuildFromDisk).
    const seen = new Set<string>();
    const docs = rawDocs.filter(({ docName }) => {
      if (seen.has(docName)) return false;
      seen.add(docName);
      return true;
    });

    const currentDocSet = new Set(docs.map((d) => d.docName));
    const newMtimes = new Map<string, number>();
    let added = 0;
    let updated = 0;

    // Phase 1: stat all files concurrently to find changed/new ones.
    const toProcess: Array<{ docName: string; filePath: string; mtimeMs: number; isNew: boolean }> =
      [];
    const statResults = await Promise.allSettled(
      docs.map(async ({ docName, filePath }) => ({
        docName,
        filePath,
        mtimeMs: (await stat(filePath)).mtimeMs,
      })),
    );
    for (const result of statResults) {
      if (result.status === 'rejected') continue; // inaccessible; skip
      const { docName, filePath, mtimeMs } = result.value;
      const storedMtime = storedMtimes.get(docName);
      if (storedMtime !== undefined && storedMtime === mtimeMs) {
        newMtimes.set(docName, mtimeMs);
        continue;
      }
      toProcess.push({ docName, filePath, mtimeMs, isNew: storedMtime === undefined });
    }

    // Phase 2: read + parse changed/new files in bounded batches.
    const BATCH_SIZE = 50;
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ docName, filePath, mtimeMs, isNew }) => ({
          docName,
          mtimeMs,
          isNew,
          markdown: await readFile(filePath, 'utf-8'),
        })),
      );
      for (const result of settled) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason }, 'Failed to reconcile file');
          continue;
        }
        const { docName, mtimeMs, isNew, markdown } = result.value;
        this.updateDocumentFromMarkdown(docName, markdown, branch);
        newMtimes.set(docName, mtimeMs);
        if (isNew) added++;
        else updated++;
      }
    }

    // Phase 3: remove entries for docs that no longer exist on disk.
    // Union of storedMtimes and graph forward-keys covers the pre-mtime cache
    // upgrade path where storedMtimes is empty but the loaded graph state may
    // still hold entries for since-deleted files.
    let deleted = 0;
    const deletedDocNames: string[] = [];
    const allKnownDocs = new Set([...storedMtimes.keys(), ...this.getState(branch).forward.keys()]);
    for (const docName of allKnownDocs) {
      // Global skill bundle nodes live OUTSIDE contentDir and are owned by the
      // global-skill ingestion path, not this content-dir reconcile — never drop
      // them here just because they're absent from the content scan.
      if (parseGlobalSkillBundleDoc(docName)) continue;
      if (!currentDocSet.has(docName)) {
        this.deleteDocument(docName, branch);
        deleted++;
        deletedDocNames.push(docName);
      }
    }

    this.mtimesByBranch.set(branch, newMtimes);
    return { added, updated, deleted, deletedDocNames };
  }

  /**
   * Register every GLOBAL skill bundle doc (SKILL + `references/**.md`) found
   * under the given global skills root(s) as a graph node, scope `global`. Nodes
   * only — bodies are deliberately not parsed (within-bundle-only; see
   * `registerNodeOnly`). Structural edges then connect each SKILL to its own
   * references via `structuralBundleNeighbors`.
   *
   * Idempotent + bounded: re-running re-registers the same nodes (and prunes
   * global nodes whose file vanished). Called on boot AND after every content
   * rebuild/reconcile (which replace state and would otherwise drop these
   * out-of-contentDir nodes), and incrementally by the managed-artifact watcher.
   * Scripts and non-`.md` references are skipped (not graph nodes).
   */
  async ingestGlobalSkillBundles(
    roots: ReadonlyArray<string>,
    branch = this.activeBranch,
  ): Promise<void> {
    const live = new Set<string>();
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let skillDirs: Dirent[];
      try {
        skillDirs = await readdir(root, { withFileTypes: true });
      } catch (err) {
        log.warn({ root, err }, `Failed to read global skills root ${root}`);
        continue;
      }
      for (const skillDir of skillDirs) {
        if (!skillDir.isDirectory()) continue;
        const name = skillDir.name;
        const dir = join(root, name);
        // SKILL doc: `__skill__/global/<name>` when `<dir>/SKILL.md` exists.
        const skillDocName = skillLiveDocName('global', name);
        if (existsSync(join(dir, 'SKILL.md'))) {
          if (parseGlobalSkillBundleDoc(skillDocName)) {
            this.registerNodeOnly(skillDocName, branch);
            live.add(skillDocName);
            // `/skill-name` REF tokens are the one body-derived signal global
            // bundles record (names only; resolution is same-scope, so a
            // global bundle still never links into a project's KB). Wiki/md
            // links stay unparsed (within-bundle-only rule).
            try {
              const raw = await readFile(join(dir, 'SKILL.md'), 'utf-8');
              this.recordSkillRefs(skillDocName, stripFrontmatter(raw).body, branch);
            } catch (err) {
              log.warn({ dir, err }, 'global skill ref-scan failed; edges skipped');
            }
          }
        }
        // Reference docs: `<dir>/references/**.md` → ext-less bundle doc names.
        const refs: Array<{ docName: string }> = [];
        await this.walkGlobalSkillReferences(join(dir, 'references'), name, '', refs);
        for (const { docName } of refs) {
          this.registerNodeOnly(docName, branch);
          live.add(docName);
        }
      }
    }
    // Prune global bundle nodes whose source file disappeared since the last
    // ingest (skill / reference deleted on disk while the index kept the node).
    // Collect first — deleteDocument mutates the forward map we'd be iterating.
    const stale: string[] = [];
    for (const docName of this.getState(branch).forward.keys()) {
      if (parseGlobalSkillBundleDoc(docName) && !live.has(docName)) stale.push(docName);
    }
    for (const docName of stale) this.deleteDocument(docName, branch);
  }

  /**
   * Recurse a global skill's `references/` dir, pushing one ext-less bundle doc
   * name per `.md` file (`__skill__/global/<name>/references/<rel>`). Mirrors the
   * project bundle reference shape so both scopes share node identities.
   */
  private async walkGlobalSkillReferences(
    dir: string,
    skillName: string,
    prefix: string,
    results: Array<{ docName: string }>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A missing `references/` dir is the common, expected case — silent.
      // A real IO failure (EACCES/EIO) silently drops a skill's references
      // from the graph, so surface it rather than swallowing indistinguishably.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn({ dir, err }, `Failed to read skill references dir ${dir}`);
      }
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.walkGlobalSkillReferences(join(dir, entry.name), skillName, rel, results);
      } else if (entry.isFile() && isSupportedDocFile(entry.name)) {
        const extLess = stripDocExtension(rel);
        results.push({
          docName: `${MANAGED_ARTIFACT_PREFIX_SKILL}global/${skillName}/references/${extLess}`,
        });
      }
    }
  }
}
