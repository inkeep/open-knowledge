import { posix } from 'node:path';
import { resolveAssetProjectPath, resolveInternalHref } from '@inkeep/open-knowledge-core';

interface FenceState {
  char: '`' | '~';
  length: number;
}

export interface RenameRewriteResult {
  markdown: string;
  rewrites: number;
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

function readInlineCode(line: string, start: number): { nextIndex: number } | null {
  let runLength = 0;
  while (line[start + runLength] === '`') runLength++;
  if (runLength === 0) return null;
  const openEnd = start + runLength;

  let i = openEnd;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let closeLen = 0;
    while (line[i + closeLen] === '`') closeLen++;
    if (closeLen === runLength) {
      return { nextIndex: i + runLength };
    }
    i += closeLen;
  }

  // Unmatched opening run — see backlink-index.ts readInlineCode for the
  // CommonMark §6.1 rationale. Skip past the full run to avoid O(N²) re-scans
  // on long unclosed backtick runs (DoS bound). Caller copies the literal run
  // verbatim via line.slice(idx, inlineCode.nextIndex).
  return { nextIndex: openEnd };
}

function readWikiLink(
  line: string,
  start: number,
): { target: string; alias: string | null; anchor: string | null; nextIndex: number } | null {
  const match = /^\[\[([^\n#[\]|]+)(?:#([^\n[\]|]+))?(?:\|([^\n[\]]+))?\]\]/.exec(
    line.slice(start),
  );
  if (!match) return null;

  const target = match[1]?.trim();
  const anchor = match[2]?.trim() || null;
  const alias = match[3]?.trim() || null;
  if (!target) return null;

  return {
    target,
    alias,
    anchor,
    nextIndex: start + match[0].length,
  };
}

interface WikiLinkOrEmbed {
  target: string;
  alias: string | null;
  anchor: string | null;
  nextIndex: number;
  embed: boolean;
}

function readWikiLinkOrEmbed(line: string, start: number): WikiLinkOrEmbed | null {
  if (line[start] === '!' && line[start + 1] === '[' && line[start + 2] === '[') {
    const link = readWikiLink(line, start + 1);
    return link ? { ...link, embed: true } : null;
  }
  if (line[start] === '[' && line[start + 1] === '[') {
    const link = readWikiLink(line, start);
    return link ? { ...link, embed: false } : null;
  }
  return null;
}

function readMarkdownLink(
  line: string,
  start: number,
): {
  text: string;
  hrefRaw: string;
  href: string;
  titleSuffix: string;
  nextIndex: number;
} | null {
  const match =
    /^\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)\)/.exec(
      line.slice(start),
    );
  if (!match) return null;

  const hrefRaw = match[2] ?? '';
  return {
    text: match[1] ?? '',
    hrefRaw,
    href: hrefRaw.startsWith('<') && hrefRaw.endsWith('>') ? hrefRaw.slice(1, -1) : hrefRaw,
    titleSuffix: match[3] ?? '',
    nextIndex: start + match[0].length,
  };
}

// Matches `![alt](src "optional title")`. Wiki-embeds (`![[file.ext]]`)
// fail this pattern because the second char after `!` is `[` not
// `]`-then-`(`, so they flow through untouched.
function readImageRef(
  line: string,
  start: number,
): {
  alt: string;
  hrefRaw: string;
  href: string;
  titleSuffix: string;
  nextIndex: number;
} | null {
  const match =
    /^!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)\)/.exec(
      line.slice(start),
    );
  if (!match) return null;

  const hrefRaw = match[2] ?? '';
  return {
    alt: match[1] ?? '',
    hrefRaw,
    href: hrefRaw.startsWith('<') && hrefRaw.endsWith('>') ? hrefRaw.slice(1, -1) : hrefRaw,
    titleSuffix: match[3] ?? '',
    nextIndex: start + match[0].length,
  };
}

function splitLines(markdown: string): Array<{ line: string; ending: string }> {
  const parts = markdown.split(/(\r\n|\r|\n)/);
  const lines: Array<{ line: string; ending: string }> = [];

  for (let i = 0; i < parts.length; i += 2) {
    lines.push({
      line: parts[i] ?? '',
      ending: parts[i + 1] ?? '',
    });
  }

  return lines;
}

function rewriteWikiLinksInLine(
  line: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
  let rewritten = '';
  let rewrites = 0;
  let idx = 0;
  const prefixLength = leadingMarkdownPrefixLength(line);

  if (prefixLength > 0) {
    rewritten += line.slice(0, prefixLength);
    idx = prefixLength;
  }

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      rewritten += line.slice(idx, idx + 2);
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        rewritten += line.slice(idx, inlineCode.nextIndex);
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        if (wikiLink.target === oldDocName) {
          rewritten += `[[${newDocName}${wikiLink.anchor ? `#${wikiLink.anchor}` : ''}${wikiLink.alias ? `|${wikiLink.alias}` : ''}]]`;
          rewrites++;
        } else {
          rewritten += line.slice(idx, wikiLink.nextIndex);
        }
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    rewritten += line[idx];
    idx++;
  }

  return { markdown: rewritten, rewrites };
}

// Recompute a RELATIVE image-ref href when the containing doc moves from
// oldSourceDocName to newSourceDocName. The asset stays put (refs-only
// rewrite); only the relative path needs adjustment.
//
// Returns null when the href should NOT be rewritten:
//   - absolute path (`/docs/photo.png`) — legacy emit, leave verbatim
//   - URL with scheme (`https://…`, `data:…`) — external, no recompute
//   - protocol-relative (`//cdn.example.com/x.png`) — external
function recomputeRelativeImageHref(
  originalHref: string,
  oldSourceDocName: string,
  newSourceDocName: string,
): string | null {
  const hashIdx = originalHref.indexOf('#');
  const hashSuffix = hashIdx >= 0 ? originalHref.slice(hashIdx) : '';
  const beforeHash = hashIdx >= 0 ? originalHref.slice(0, hashIdx) : originalHref;
  const queryIdx = beforeHash.indexOf('?');
  const querySuffix = queryIdx >= 0 ? beforeHash.slice(queryIdx) : '';
  const pathPart = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;

  // Absolute / external — leave unchanged.
  if (pathPart.startsWith('/') || pathPart.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(pathPart)) return null;

  const oldDir = posix.dirname(oldSourceDocName);
  const newDir = posix.dirname(newSourceDocName);
  if (oldDir === newDir) return null; // same dir → relative path unchanged

  // Resolve asset's contentDir-relative path from oldSource's dirname.
  const oldDirAnchored = oldDir === '.' ? '/' : `/${oldDir}/`;
  const assetFromRoot = posix.resolve(oldDirAnchored, pathPart).slice(1);

  // Compute new relative path from newSource's dirname.
  let newRef = posix.relative(newDir === '.' ? '' : newDir, assetFromRoot);
  newRef ||= posix.basename(assetFromRoot);

  // Preserve leading `./` if original had it (and result is not already an
  // ancestor reference).
  if (pathPart.startsWith('./') && !newRef.startsWith('./') && !newRef.startsWith('../')) {
    newRef = `./${newRef}`;
  }

  return `${newRef}${querySuffix}${hashSuffix}`;
}

function decodeHrefForAssetResolution(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function splitHrefPathAndSuffix(href: string): {
  pathPart: string;
  suffix: string;
} {
  const hashIndex = href.indexOf('#');
  const hashSuffix = hashIndex >= 0 ? href.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const queryIndex = beforeHash.indexOf('?');
  const querySuffix = queryIndex >= 0 ? beforeHash.slice(queryIndex) : '';
  const pathPart = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  return { pathPart, suffix: `${querySuffix}${hashSuffix}` };
}

function buildAssetHrefFromSource(
  originalHref: string,
  sourceDocName: string,
  newAssetPath: string,
  options: { encodePath?: boolean } = {},
): string {
  const encodePath = options.encodePath ?? true;
  const formatPath = (path: string) => (encodePath ? encodeURI(path) : path);
  const { pathPart, suffix } = splitHrefPathAndSuffix(originalHref);
  if (pathPart.startsWith('/')) return `/${formatPath(newAssetPath)}${suffix}`;

  const sourceDir = posix.dirname(sourceDocName);
  let nextHref = posix.relative(sourceDir === '.' ? '' : sourceDir, newAssetPath);
  nextHref ||= posix.basename(newAssetPath);

  if (pathPart.startsWith('./') && !nextHref.startsWith('./') && !nextHref.startsWith('../')) {
    nextHref = `./${nextHref}`;
  }

  return `${formatPath(nextHref)}${suffix}`;
}

function rewriteAssetHrefForRename(
  originalHref: string,
  sourceDocName: string,
  oldAssetPath: string,
  newAssetPath: string,
  options: { encodePath?: boolean } = {},
): string | null {
  const decodedHref = decodeHrefForAssetResolution(originalHref);
  const resolved = resolveAssetProjectPath(decodedHref, sourceDocName);
  if (resolved !== oldAssetPath) return null;
  return buildAssetHrefFromSource(originalHref, sourceDocName, newAssetPath, options);
}

function recomputeRelativeMarkdownHref(
  originalHref: string,
  sourceDocName: string,
  newDocName: string,
): string {
  const hashIndex = originalHref.indexOf('#');
  const hashSuffix = hashIndex >= 0 ? originalHref.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? originalHref.slice(0, hashIndex) : originalHref;
  const queryIndex = beforeHash.indexOf('?');
  const querySuffix = queryIndex >= 0 ? beforeHash.slice(queryIndex) : '';
  const pathPart = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;

  const keepsRootPrefix = pathPart.startsWith('/');
  const sourceDir = posix.dirname(sourceDocName);
  let relativePath = keepsRootPrefix
    ? `/${newDocName}`
    : posix.relative(sourceDir === '.' ? '' : sourceDir, newDocName);
  relativePath ||= posix.basename(newDocName);

  // Preserve whatever supported doc extension the authored link carried.
  // The canonical list lives at `packages/server/src/doc-extensions.ts`; this
  // function is called in tight loops per link-rewrite so it inlines the
  // two-case check rather than importing `isSupportedDocFile`.
  if (pathPart.endsWith('.mdx')) {
    relativePath += '.mdx';
  } else if (pathPart.endsWith('.md')) {
    relativePath += '.md';
  }

  if (
    !keepsRootPrefix &&
    pathPart.startsWith('./') &&
    !relativePath.startsWith('./') &&
    !relativePath.startsWith('../')
  ) {
    relativePath = `./${relativePath}`;
  }

  return `${relativePath}${querySuffix}${hashSuffix}`;
}

function rewriteMarkdownLinksInLine(
  line: string,
  sourceDocName: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
  let rewritten = '';
  let rewrites = 0;
  let idx = 0;
  const prefixLength = leadingMarkdownPrefixLength(line);

  if (prefixLength > 0) {
    rewritten += line.slice(0, prefixLength);
    idx = prefixLength;
  }

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      rewritten += line.slice(idx, idx + 2);
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        rewritten += line.slice(idx, inlineCode.nextIndex);
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        rewritten += line.slice(idx, wikiLink.nextIndex);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    // Image refs (`![alt](src)`) get path-recomputed when the SOURCE
    // doc itself moves (sourceDocName === oldDocName). Wiki-embed refs
    // (`![[file]]`) and image refs in docs that aren't moving fall
    // through untouched (refs-only rewrite).
    if (line[idx] === '!' && line[idx + 1] === '[') {
      const imageRef = readImageRef(line, idx);
      if (imageRef) {
        const isContainingDocMove = sourceDocName === oldDocName && oldDocName !== newDocName;
        const nextHref = isContainingDocMove
          ? recomputeRelativeImageHref(imageRef.href, oldDocName, newDocName)
          : null;
        if (nextHref !== null) {
          const hrefRaw =
            imageRef.hrefRaw.startsWith('<') && imageRef.hrefRaw.endsWith('>')
              ? `<${nextHref}>`
              : nextHref;
          rewritten += `![${imageRef.alt}](${hrefRaw}${imageRef.titleSuffix})`;
          rewrites++;
        } else {
          rewritten += line.slice(idx, imageRef.nextIndex);
        }
        idx = imageRef.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[') {
      const markdownLink = readMarkdownLink(line, idx);
      if (markdownLink) {
        const resolved = resolveInternalHref(markdownLink.href, sourceDocName);
        if (resolved?.docName === oldDocName) {
          const nextHref = recomputeRelativeMarkdownHref(
            markdownLink.href,
            sourceDocName,
            newDocName,
          );
          const hrefRaw =
            markdownLink.hrefRaw.startsWith('<') && markdownLink.hrefRaw.endsWith('>')
              ? `<${nextHref}>`
              : nextHref;
          rewritten += `[${markdownLink.text}](${hrefRaw}${markdownLink.titleSuffix})`;
          rewrites++;
        } else {
          rewritten += line.slice(idx, markdownLink.nextIndex);
        }
        idx = markdownLink.nextIndex;
        continue;
      }
    }

    rewritten += line[idx];
    idx++;
  }

  return { markdown: rewritten, rewrites };
}

function renderWikiLinkOrEmbed(link: WikiLinkOrEmbed, target: string): string {
  return `${link.embed ? '!' : ''}[[${target}${link.anchor ? `#${link.anchor}` : ''}${link.alias ? `|${link.alias}` : ''}]]`;
}

const HTML_ASSET_ATTR_RE =
  /(\s(?:href|src)\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”|([^\s"'=<>`]+))/gi;

function rewriteHtmlAssetAttrsInTag(
  tag: string,
  sourceDocName: string,
  oldAssetPath: string,
  newAssetPath: string,
): RenameRewriteResult {
  let rewrites = 0;
  const markdown = tag.replace(HTML_ASSET_ATTR_RE, (whole, prefix, double, single, curly, bare) => {
    const value = double ?? single ?? curly ?? bare;
    if (typeof value !== 'string') return whole;
    const nextHref = rewriteAssetHrefForRename(value, sourceDocName, oldAssetPath, newAssetPath);
    if (nextHref === null) return whole;
    rewrites++;
    if (double !== undefined) return `${prefix}"${nextHref}"`;
    if (single !== undefined) return `${prefix}'${nextHref}'`;
    if (curly !== undefined) return `${prefix}“${nextHref}”`;
    return `${prefix}${nextHref}`;
  });
  return { markdown, rewrites };
}

function rewriteAssetReferencesInLine(
  line: string,
  sourceDocName: string,
  oldAssetPath: string,
  newAssetPath: string,
): RenameRewriteResult {
  let rewritten = '';
  let rewrites = 0;
  let idx = 0;
  const prefixLength = leadingMarkdownPrefixLength(line);

  if (prefixLength > 0) {
    rewritten += line.slice(0, prefixLength);
    idx = prefixLength;
  }

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      rewritten += line.slice(idx, idx + 2);
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        rewritten += line.slice(idx, inlineCode.nextIndex);
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    const wikiLink = readWikiLinkOrEmbed(line, idx);
    if (wikiLink) {
      const nextTarget = rewriteAssetHrefForRename(
        wikiLink.target,
        sourceDocName,
        oldAssetPath,
        newAssetPath,
        { encodePath: false },
      );
      if (nextTarget !== null) {
        rewritten += renderWikiLinkOrEmbed(wikiLink, nextTarget);
        rewrites++;
      } else {
        rewritten += line.slice(idx, wikiLink.nextIndex);
      }
      idx = wikiLink.nextIndex;
      continue;
    }

    if (line.startsWith('<!--', idx)) {
      const commentEnd = line.indexOf('-->', idx + 4);
      if (commentEnd === -1) {
        rewritten += line.slice(idx);
        break;
      }
      rewritten += line.slice(idx, commentEnd + 3);
      idx = commentEnd + 3;
      continue;
    }

    if (line[idx] === '<') {
      const tagEnd = line.indexOf('>', idx + 1);
      if (tagEnd !== -1) {
        const tag = line.slice(idx, tagEnd + 1);
        const htmlRewrite = rewriteHtmlAssetAttrsInTag(
          tag,
          sourceDocName,
          oldAssetPath,
          newAssetPath,
        );
        if (htmlRewrite.rewrites > 0) {
          rewritten += htmlRewrite.markdown;
          rewrites += htmlRewrite.rewrites;
          idx = tagEnd + 1;
          continue;
        }
      }
    }

    if (line[idx] === '!' && line[idx + 1] === '[') {
      const imageRef = readImageRef(line, idx);
      if (imageRef) {
        const nextHref = rewriteAssetHrefForRename(
          imageRef.href,
          sourceDocName,
          oldAssetPath,
          newAssetPath,
        );
        if (nextHref !== null) {
          const hrefRaw =
            imageRef.hrefRaw.startsWith('<') && imageRef.hrefRaw.endsWith('>')
              ? `<${nextHref}>`
              : nextHref;
          rewritten += `![${imageRef.alt}](${hrefRaw}${imageRef.titleSuffix})`;
          rewrites++;
        } else {
          rewritten += line.slice(idx, imageRef.nextIndex);
        }
        idx = imageRef.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[') {
      const markdownLink = readMarkdownLink(line, idx);
      if (markdownLink) {
        const nextHref = rewriteAssetHrefForRename(
          markdownLink.href,
          sourceDocName,
          oldAssetPath,
          newAssetPath,
        );
        if (nextHref !== null) {
          const hrefRaw =
            markdownLink.hrefRaw.startsWith('<') && markdownLink.hrefRaw.endsWith('>')
              ? `<${nextHref}>`
              : nextHref;
          rewritten += `[${markdownLink.text}](${hrefRaw}${markdownLink.titleSuffix})`;
          rewrites++;
        } else {
          rewritten += line.slice(idx, markdownLink.nextIndex);
        }
        idx = markdownLink.nextIndex;
        continue;
      }
    }

    rewritten += line[idx];
    idx++;
  }

  return { markdown: rewritten, rewrites };
}

// Single-line `<Mirror>` JSX scanner. Matches a self-closing tag and
// rewrites the `src=` attribute when its value equals `oldDocName`. The
// `<Mirror>` canonical is jsx-void / self-closing per its descriptor, so
// we don't need to handle paired open/close. Multi-line tag content
// (`<Mirror\n  src="…"\n  anchor="…"\n/>`) is intentionally NOT rewritten
// here — a rare authoring shape; if it becomes common, lift this scanner
// to an mdast-walking variant. The line-scoped scanner keeps the rewrite
// path predictable + idempotent for the common single-line case.
const MIRROR_TAG_RE = /<Mirror\b([^>]*)\/>/g;
const MIRROR_SRC_ATTR_RE = /(\bsrc=)(["'])([^"']*)\2/g;

function rewriteMirrorSrcInLine(
  line: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
  // Walk the line so inline-code spans are skipped verbatim — mirrors
  // `rewriteWikiLinksInLine` and the markdown-link rewriter. Without this,
  // an `<Mirror src="…" />` inside backticks (e.g. documentation showing
  // Mirror syntax) gets rewritten on doc rename and corrupts the example.
  let rewritten = '';
  let rewrites = 0;
  let idx = 0;

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      rewritten += line.slice(idx, idx + 2);
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        rewritten += line.slice(idx, inlineCode.nextIndex);
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    if (line[idx] === '<') {
      // Per-tag regex instance — concurrent rename passes share no state.
      const tagRe = new RegExp(MIRROR_TAG_RE.source);
      const sliceFromHere = line.slice(idx);
      const match = tagRe.exec(sliceFromHere);
      if (match && match.index === 0) {
        const [full, attrs] = match;
        const attrRe = new RegExp(MIRROR_SRC_ATTR_RE.source, MIRROR_SRC_ATTR_RE.flags);
        const newAttrs = attrs.replace(attrRe, (whole, prefix, quote, value) => {
          if (value === oldDocName) {
            rewrites++;
            return `${prefix}${quote}${newDocName}${quote}`;
          }
          return whole;
        });
        rewritten += `<Mirror${newAttrs}/>`;
        idx += full.length;
        continue;
      }
    }

    rewritten += line[idx];
    idx++;
  }

  return { markdown: rewritten, rewrites };
}

export function rewriteMirrorSrcForDocumentRename(
  markdown: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
  let fence: FenceState | null = null;
  let rewrites = 0;

  const rewrittenMarkdown = splitLines(markdown)
    .map(({ line, ending }) => {
      if (fence) {
        if (isFenceClose(line, fence)) {
          fence = null;
        }
        return `${line}${ending}`;
      }

      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
        return `${line}${ending}`;
      }

      const rewrittenLine = rewriteMirrorSrcInLine(line, oldDocName, newDocName);
      rewrites += rewrittenLine.rewrites;
      return `${rewrittenLine.markdown}${ending}`;
    })
    .join('');

  return { markdown: rewrittenMarkdown, rewrites };
}

export function rewriteWikiLinksForDocumentRename(
  markdown: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
  let fence: FenceState | null = null;
  let rewrites = 0;

  const rewrittenMarkdown = splitLines(markdown)
    .map(({ line, ending }) => {
      if (fence) {
        if (isFenceClose(line, fence)) {
          fence = null;
        }
        return `${line}${ending}`;
      }

      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
        return `${line}${ending}`;
      }

      const rewrittenLine = rewriteWikiLinksInLine(line, oldDocName, newDocName);
      rewrites += rewrittenLine.rewrites;
      return `${rewrittenLine.markdown}${ending}`;
    })
    .join('');

  return { markdown: rewrittenMarkdown, rewrites };
}

export function rewriteMarkdownLinksForDocumentRename(
  markdown: string,
  sourceDocName: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
  let fence: FenceState | null = null;
  let rewrites = 0;

  const rewrittenMarkdown = splitLines(markdown)
    .map(({ line, ending }) => {
      if (fence) {
        if (isFenceClose(line, fence)) {
          fence = null;
        }
        return `${line}${ending}`;
      }

      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
        return `${line}${ending}`;
      }

      const rewrittenLine = rewriteMarkdownLinksInLine(line, sourceDocName, oldDocName, newDocName);
      rewrites += rewrittenLine.rewrites;
      return `${rewrittenLine.markdown}${ending}`;
    })
    .join('');

  return { markdown: rewrittenMarkdown, rewrites };
}

export function rewriteAssetReferencesForRename(
  markdown: string,
  sourceDocName: string,
  oldAssetPath: string,
  newAssetPath: string,
): RenameRewriteResult {
  let fence: FenceState | null = null;
  let rewrites = 0;

  const rewrittenMarkdown = splitLines(markdown)
    .map(({ line, ending }) => {
      if (fence) {
        if (isFenceClose(line, fence)) {
          fence = null;
        }
        return `${line}${ending}`;
      }

      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
        return `${line}${ending}`;
      }

      const rewrittenLine = rewriteAssetReferencesInLine(
        line,
        sourceDocName,
        oldAssetPath,
        newAssetPath,
      );
      rewrites += rewrittenLine.rewrites;
      return `${rewrittenLine.markdown}${ending}`;
    })
    .join('');

  return { markdown: rewrittenMarkdown, rewrites };
}

function rewriteOutboundMarkdownLinksInLine(
  line: string,
  oldSourceDocName: string,
  newSourceDocName: string,
): RenameRewriteResult {
  let rewritten = '';
  let rewrites = 0;
  let idx = 0;
  const prefixLength = leadingMarkdownPrefixLength(line);

  if (prefixLength > 0) {
    rewritten += line.slice(0, prefixLength);
    idx = prefixLength;
  }

  while (idx < line.length) {
    if (line[idx] === '\\' && idx + 1 < line.length) {
      rewritten += line.slice(idx, idx + 2);
      idx += 2;
      continue;
    }

    if (line[idx] === '`') {
      const inlineCode = readInlineCode(line, idx);
      if (inlineCode) {
        rewritten += line.slice(idx, inlineCode.nextIndex);
        idx = inlineCode.nextIndex;
        continue;
      }
    }

    // Wiki links resolve via the basename index, not relative paths — leave
    // them alone here. Self-rename of `[[oldDocName]]` → `[[newDocName]]` is
    // handled by `rewriteWikiLinksForDocumentRename` in the self-rename pass.
    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        rewritten += line.slice(idx, wikiLink.nextIndex);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

    // Image refs are recomputed by `rewriteMarkdownLinksInLine`'s
    // `isContainingDocMove` branch in the self-rename pass — skip here so
    // we don't double-recompute (which would treat an already-rewritten
    // href as if it were still anchored to the old source dir).
    if (line[idx] === '!' && line[idx + 1] === '[') {
      const imageRef = readImageRef(line, idx);
      if (imageRef) {
        rewritten += line.slice(idx, imageRef.nextIndex);
        idx = imageRef.nextIndex;
        continue;
      }
    }

    if (line[idx] === '[') {
      const markdownLink = readMarkdownLink(line, idx);
      if (markdownLink) {
        const resolved = resolveInternalHref(markdownLink.href, oldSourceDocName);
        if (resolved !== null) {
          const nextHref = recomputeRelativeMarkdownHref(
            markdownLink.href,
            newSourceDocName,
            resolved.docName,
          );
          if (nextHref !== markdownLink.href) {
            const hrefRaw =
              markdownLink.hrefRaw.startsWith('<') && markdownLink.hrefRaw.endsWith('>')
                ? `<${nextHref}>`
                : nextHref;
            rewritten += `[${markdownLink.text}](${hrefRaw}${markdownLink.titleSuffix})`;
            rewrites++;
          } else {
            rewritten += line.slice(idx, markdownLink.nextIndex);
          }
        } else {
          rewritten += line.slice(idx, markdownLink.nextIndex);
        }
        idx = markdownLink.nextIndex;
        continue;
      }
    }

    rewritten += line[idx];
    idx++;
  }

  return { markdown: rewritten, rewrites };
}

/**
 * Recompute relative outbound markdown-link hrefs in a document whose own
 * location moved from `oldSourceDocName` to `newSourceDocName`. Image refs
 * and self-targeting wiki/markdown links are NOT handled here — they're
 * covered by `rewriteMarkdownLinksForDocumentRename` /
 * `rewriteWikiLinksForDocumentRename` invoked with the same (old, new) pair
 * (the self-rename pass in `applyRenameMap`).
 *
 * No-op when the dirname doesn't change — relative paths to non-renamed
 * targets stay correct on a same-folder rename.
 */
export function rewriteOutboundMarkdownLinksForSourceMove(
  markdown: string,
  oldSourceDocName: string,
  newSourceDocName: string,
): RenameRewriteResult {
  if (posix.dirname(oldSourceDocName) === posix.dirname(newSourceDocName)) {
    return { markdown, rewrites: 0 };
  }

  let fence: FenceState | null = null;
  let rewrites = 0;

  const rewrittenMarkdown = splitLines(markdown)
    .map(({ line, ending }) => {
      if (fence) {
        if (isFenceClose(line, fence)) {
          fence = null;
        }
        return `${line}${ending}`;
      }

      const nextFence = matchFence(line);
      if (nextFence) {
        fence = nextFence;
        return `${line}${ending}`;
      }

      const rewrittenLine = rewriteOutboundMarkdownLinksInLine(
        line,
        oldSourceDocName,
        newSourceDocName,
      );
      rewrites += rewrittenLine.rewrites;
      return `${rewrittenLine.markdown}${ending}`;
    })
    .join('');

  return { markdown: rewrittenMarkdown, rewrites };
}
