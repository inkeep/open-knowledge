import { posix } from 'node:path';
import {
  encodeHrefPath,
  encodeHrefPathSegment,
  isExternalHref,
  type JsxSrcRefTagSpec,
  resolveAssetProjectPath,
  resolveInternalHref,
} from '@inkeep/open-knowledge-core';
import {
  createJsxSrcAttrRe,
  readJsxSrcRefTagAt,
  resolveJsxSrcRefTarget,
} from './jsx-src-ref-tags.ts';
import { readMarkdownLinkAt, readWikiLinkAt } from './link-syntax.ts';

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

  return { nextIndex: openEnd };
}

function readWikiLink(
  line: string,
  start: number,
): { target: string; alias: string | null; anchor: string | null; nextIndex: number } | null {
  const match = readWikiLinkAt(line, start);
  if (!match) return null;
  return {
    target: match.target,
    alias: match.alias,
    anchor: match.anchor,
    nextIndex: match.end,
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
  const match = readWikiLinkAt(line, start);
  if (!match) return null;
  return {
    target: match.target,
    alias: match.alias,
    anchor: match.anchor,
    nextIndex: match.end,
    embed: match.embed,
  };
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
  const match = readMarkdownLinkAt(line, start);
  if (!match || match.image) return null;
  return {
    text: match.label,
    hrefRaw: match.hrefRaw,
    href: match.href,
    titleSuffix: match.titleSuffix,
    nextIndex: match.end,
  };
}

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
  const match = readMarkdownLinkAt(line, start);
  if (!match?.image) return null;
  return {
    alt: match.label,
    hrefRaw: match.hrefRaw,
    href: match.href,
    titleSuffix: match.titleSuffix,
    nextIndex: match.end,
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

  if (pathPart.startsWith('/') || pathPart.startsWith('//')) return null;
  if (isExternalHref(pathPart)) return null;

  const oldDir = posix.dirname(oldSourceDocName);
  const newDir = posix.dirname(newSourceDocName);
  if (oldDir === newDir) return null;

  const oldDirAnchored = oldDir === '.' ? '/' : `/${oldDir}/`;
  const assetFromRoot = posix.resolve(oldDirAnchored, pathPart).slice(1);

  let newRef = posix.relative(newDir === '.' ? '' : newDir, assetFromRoot);
  newRef ||= posix.basename(assetFromRoot);

  if (pathPart.startsWith('./') && !newRef.startsWith('./') && !newRef.startsWith('../')) {
    newRef = `./${newRef}`;
  }

  return `${newRef}${querySuffix}${hashSuffix}`;
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
  const formatPath = (path: string) => (encodePath ? encodeHrefPath(path) : path);
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
  options: { literal: boolean; encodePath?: boolean },
): string | null {
  const resolved = resolveAssetProjectPath(originalHref, sourceDocName, {
    literal: options.literal,
  });
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
    ? `/${encodeHrefPath(newDocName)}`
    : encodeHrefPath(posix.relative(sourceDir === '.' ? '' : sourceDir, newDocName));
  relativePath ||= encodeHrefPathSegment(posix.basename(newDocName));

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
    const nextHref = rewriteAssetHrefForRename(value, sourceDocName, oldAssetPath, newAssetPath, {
      literal: false,
    });
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
        { literal: true, encodePath: false },
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
          { literal: false },
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
          { literal: false },
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

function relativeJsxSrcRef(
  anchorDocName: string,
  targetDocName: string,
  originalValue: string,
): string {
  const anchorDir = posix.dirname(anchorDocName);
  let ref = posix.relative(anchorDir === '.' ? '' : anchorDir, targetDocName);
  ref ||= posix.basename(targetDocName);
  if (originalValue.startsWith('./') && !ref.startsWith('./') && !ref.startsWith('../')) {
    ref = `./${ref}`;
  }
  return ref;
}

function rewriteJsxSrcAttrValue(
  spec: JsxSrcRefTagSpec,
  value: string,
  sourceDocName: string,
  oldDocName: string,
  newDocName: string,
): string | null {
  const next = computeNextJsxSrcAttrValue(spec, value, sourceDocName, oldDocName, newDocName);
  if (next !== null && /["'<>]/.test(next)) return null;
  return next;
}

function computeNextJsxSrcAttrValue(
  spec: JsxSrcRefTagSpec,
  value: string,
  sourceDocName: string,
  oldDocName: string,
  newDocName: string,
): string | null {
  if (spec.resolution === 'bare-doc-name') {
    return value === oldDocName ? newDocName : null;
  }
  const resolved = resolveJsxSrcRefTarget(spec, value, sourceDocName);
  if (resolved === null) return null;
  const isContainingDocMove = sourceDocName === oldDocName && oldDocName !== newDocName;
  if (resolved !== oldDocName && !isContainingDocMove) return null;
  const target = resolved === oldDocName ? newDocName : resolved;
  if (value.startsWith('/')) {
    return resolved === oldDocName ? `/${target}` : null;
  }
  const anchorDocName = isContainingDocMove ? newDocName : sourceDocName;
  const candidate = relativeJsxSrcRef(anchorDocName, target, value);
  const next =
    resolveJsxSrcRefTarget(spec, candidate, anchorDocName) === target ? candidate : `/${target}`;
  return next === value ? null : next;
}

function rewriteJsxSrcRefsInLine(
  line: string,
  sourceDocName: string,
  oldDocName: string,
  newDocName: string,
): RenameRewriteResult {
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
      const tag = readJsxSrcRefTagAt(line, idx);
      if (tag) {
        const attrRe = createJsxSrcAttrRe(tag.spec.attrName);
        const newAttrs = tag.attrs.replace(attrRe, (whole, prefix, quote, value) => {
          const nextValue = rewriteJsxSrcAttrValue(
            tag.spec,
            value,
            sourceDocName,
            oldDocName,
            newDocName,
          );
          if (nextValue === null) return whole;
          rewrites++;
          return `${prefix}${quote}${nextValue}${quote}`;
        });
        rewritten += `<${tag.spec.tagName}${newAttrs}/>`;
        idx += tag.matchLength;
        continue;
      }
    }

    rewritten += line[idx];
    idx++;
  }

  return { markdown: rewritten, rewrites };
}

export function rewriteJsxSrcRefsForDocumentRename(
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

      const rewrittenLine = rewriteJsxSrcRefsInLine(line, sourceDocName, oldDocName, newDocName);
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

    if (line[idx] === '[' && line[idx + 1] === '[') {
      const wikiLink = readWikiLink(line, idx);
      if (wikiLink) {
        rewritten += line.slice(idx, wikiLink.nextIndex);
        idx = wikiLink.nextIndex;
        continue;
      }
    }

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
