import { randomUUID } from 'node:crypto';
import { prependFrontmatter, stripFrontmatter } from '@inkeep/open-knowledge-core';
import {
  rewriteJsxSrcRefsForDocumentRename,
  rewriteMarkdownLinksForDocumentRename,
  rewriteOutboundMarkdownLinksForSourceMove,
  rewriteWikiLinksForDocumentRename,
} from './managed-rename-rewrite.ts';

interface ManagedRenameAffectedDocPair {
  from: string;
  to: string;
}

interface ManagedRenameRewriteSummary {
  markdown: string;
  rewrites: number;
}

export class ManagedRenameCollisionError extends Error {
  readonly colliding: ReadonlyArray<{
    readonly existing: string;
    readonly incoming: string;
    readonly to: string;
  }>;

  constructor(
    colliding: ReadonlyArray<{
      readonly existing: string;
      readonly incoming: string;
      readonly to: string;
    }>,
  ) {
    super(
      `Managed rename collision: ${colliding
        .map((c) => `'${c.existing}' and '${c.incoming}' both target '${c.to}'`)
        .join('; ')}`,
    );
    this.name = 'ManagedRenameCollisionError';
    this.colliding = colliding;
  }
}

export class ManagedRenameSourceNotFoundError extends Error {
  readonly kind: 'file' | 'folder' | 'asset';
  constructor(kind: 'file' | 'folder' | 'asset', message = `${kind} does not exist`) {
    super(message);
    this.name = 'ManagedRenameSourceNotFoundError';
    this.kind = kind;
  }
}

export class ManagedRenameDestinationExistsError extends Error {
  constructor() {
    super('Destination already exists');
    this.name = 'ManagedRenameDestinationExistsError';
  }
}

export class ManagedRenameSourceTypeMismatchError extends Error {
  readonly kind: 'file' | 'folder' | 'asset';
  constructor(kind: 'file' | 'folder' | 'asset', message = `Source path is not a ${kind}`) {
    super(message);
    this.name = 'ManagedRenameSourceTypeMismatchError';
    this.kind = kind;
  }
}

export class ManagedRenameInvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedRenameInvalidRequestError';
  }
}

export class ManagedRenameReservedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedRenameReservedPathError';
  }
}

export { SymlinkEscapeError } from './fs-safety.ts';

export class BacklinkIndexRequiredError extends Error {
  constructor() {
    super('Managed rename requires backlink index support');
    this.name = 'BacklinkIndexRequiredError';
  }
}

export class ManagedRenameSnapshotMissingError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super(`Cannot snapshot missing document: ${docName}`);
    this.name = 'ManagedRenameSnapshotMissingError';
    this.docName = docName;
  }
}

export class ManagedRenameMissingDocumentError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super(`Cannot rename missing document: ${docName}`);
    this.name = 'ManagedRenameMissingDocumentError';
    this.docName = docName;
  }
}

export function buildRenameMap(
  affectedDocs: readonly ManagedRenameAffectedDocPair[],
): Map<string, string> {
  const map = new Map<string, string>();
  const collisions: Array<{ existing: string; incoming: string; to: string }> = [];
  for (const { from, to } of affectedDocs) {
    for (const [otherFrom, otherTo] of map) {
      if (otherFrom !== from && otherTo === to) {
        collisions.push({ existing: otherFrom, incoming: from, to });
      }
    }
    map.set(from, to);
  }
  if (collisions.length > 0) throw new ManagedRenameCollisionError(collisions);
  return map;
}

function rewriteSupportedLinksForRename(
  markdown: string,
  sourceDocName: string,
  oldDocName: string,
  newDocName: string,
): ManagedRenameRewriteSummary {
  const { frontmatter, body } = stripFrontmatter(markdown);
  const wikiRewrite = rewriteWikiLinksForDocumentRename(body, oldDocName, newDocName);
  const markdownRewrite = rewriteMarkdownLinksForDocumentRename(
    wikiRewrite.markdown,
    sourceDocName,
    oldDocName,
    newDocName,
  );
  const jsxRewrite = rewriteJsxSrcRefsForDocumentRename(
    markdownRewrite.markdown,
    sourceDocName,
    oldDocName,
    newDocName,
  );
  return {
    markdown: prependFrontmatter(frontmatter, jsxRewrite.markdown),
    rewrites: wikiRewrite.rewrites + markdownRewrite.rewrites + jsxRewrite.rewrites,
  };
}

export function applyRenameMap(
  content: string,
  currentDocName: string,
  renameMap: ReadonlyMap<string, string>,
): ManagedRenameRewriteSummary {
  let markdown = content;
  let rewrites = 0;

  let selfRenamedTo: string | undefined;
  const otherRenames: Array<readonly [string, string]> = [];
  for (const [from, to] of renameMap) {
    if (from === to) continue;
    if (from === currentDocName) {
      selfRenamedTo = to;
    } else {
      otherRenames.push([from, to] as const);
    }
  }

  if (selfRenamedTo !== undefined) {
    const selfPass = rewriteSupportedLinksForRename(
      markdown,
      currentDocName,
      currentDocName,
      selfRenamedTo,
    );
    markdown = selfPass.markdown;
    rewrites += selfPass.rewrites;

    const { frontmatter: fm2, body: body2 } = stripFrontmatter(markdown);
    const outboundPass = rewriteOutboundMarkdownLinksForSourceMove(
      body2,
      currentDocName,
      selfRenamedTo,
    );
    markdown = prependFrontmatter(fm2, outboundPass.markdown);
    rewrites += outboundPass.rewrites;
  }

  const resolutionSourceName = selfRenamedTo ?? currentDocName;

  const placeholderToFinal = new Map<string, string>();
  for (const [from, to] of otherRenames) {
    const placeholder = `__OK_RENAME_${randomUUID().replaceAll('-', '')}__`;
    const phase1 = rewriteSupportedLinksForRename(
      markdown,
      resolutionSourceName,
      from,
      placeholder,
    );
    if (phase1.rewrites > 0) {
      markdown = phase1.markdown;
      rewrites += phase1.rewrites;
      placeholderToFinal.set(placeholder, to);
    }
  }

  for (const [placeholder, to] of placeholderToFinal) {
    const phase2 = rewriteSupportedLinksForRename(markdown, resolutionSourceName, placeholder, to);
    markdown = phase2.markdown;
  }

  return { markdown, rewrites };
}
