/**
 * The three sibling write-side primitives for the Y.Text-is-truth contract (precedent #38):
 * `composeAndWriteRawBody`, `replaceRawBody` and `deriveFragmentFromYtext`, each owning one
 * paired-write semantics. No primitive calls `doc.transact()`; the caller wraps.
 */
import {
  applyFastDiff,
  composeWithDerivedBody,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import type { DeriveLossDetectOptions } from './bridge-loss-detector.ts';
import { mdManager, schema } from './md-manager.ts';
import { withSpanSync } from './telemetry.ts';

interface EmbedResolverContext {
  resolveEmbed: (basename: string, sourcePath: string) => string | null;
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  sourcePath: string;
}

type EmbedResolverArg = EmbedResolverContext | false | undefined;

export interface PrecomputedParse {
  rawContent: string;
  parsedJson: JSONContent;
}

function parseBodyWithPrecompute(
  document: Y.Doc,
  rawContent: string,
  embedResolver: EmbedResolverArg,
  precomputed: PrecomputedParse | undefined,
): JSONContent {
  const { body } = stripFrontmatter(rawContent);
  if (precomputed !== undefined && precomputed.rawContent === rawContent) {
    return precomputed.parsedJson;
  }
  return withSpanSync(
    'md.parseWithFallback',
    { attributes: { 'body.bytes': body.length, 'doc.name': document.guid } },
    () => mdManager.parseWithFallback(body, buildParseOpts(embedResolver)),
  );
}

function buildParseOpts(embedResolver: EmbedResolverArg):
  | {
      resolveEmbed: EmbedResolverContext['resolveEmbed'];
      resolveSize?: EmbedResolverContext['resolveSize'];
      sourcePath: string;
    }
  | undefined {
  return embedResolver
    ? {
        resolveEmbed: embedResolver.resolveEmbed,
        resolveSize: embedResolver.resolveSize,
        sourcePath: embedResolver.sourcePath,
      }
    : undefined;
}

function serializeFragmentBody(xmlFragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

function reportPairedDeriveLoss(
  detect: DeriveLossDetectOptions,
  pendingBody: string,
  parsedJson: JSONContent,
  xmlFragment: Y.XmlFragment,
  restoreFrontmatter: string,
  parseOpts: ReturnType<typeof buildParseOpts>,
): void {
  const rebuiltBody = serializeFragmentBody(xmlFragment);
  const ytextDerivedBody = mdManager.serialize(parsedJson);
  const { body: baselineRawBody } = stripFrontmatter(detect.baselineFullMd);
  const baselineBody = mdManager.serialize(mdManager.parseWithFallback(baselineRawBody, parseOpts));
  detect.report({
    pendingBody,
    baselineBody,
    ytextDerivedBody,
    rebuiltBody,
    restorePayload: composeWithDerivedBody(restoreFrontmatter, pendingBody).md,
  });
}

/**
 * Applies raw composed bytes to Y.Text via an incremental line-aligned diff and derives
 * XmlFragment via parse. Must run inside an outer `doc.transact(..., origin)` block for atomicity
 * and the per-session frozen origin identity (precedent #24).
 */
export type ComposeWriteSurface =
  | 'agent'
  | 'file-watcher'
  | 'managed-rename'
  | 'undo'
  | 'frontmatter';

export function composeAndWriteRawBody(
  document: Y.Doc,
  rawContent: string,
  surface: ComposeWriteSurface,
  embedResolver?: EmbedResolverArg,
  precomputed?: PrecomputedParse,
  detect?: DeriveLossDetectOptions,
): void {
  withSpanSync(
    'bridge.composeAndWriteRawBody',
    {
      attributes: {
        surface,
        'body.bytes': rawContent.length,
        'doc.name': document.guid,
      },
    },
    () => {
      const xmlFragment = document.getXmlFragment('default');
      const ytext = document.getText('source');
      const currentYText = ytext.toString();

      const parsedJson = parseBodyWithPrecompute(document, rawContent, embedResolver, precomputed);
      const pmNode = schema.nodeFromJSON(parsedJson);

      const pendingBody = detect ? serializeFragmentBody(xmlFragment) : undefined;

      if (currentYText !== rawContent) {
        applyFastDiff(ytext, currentYText, rawContent);
      }

      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(document, xmlFragment, pmNode, meta);

      if (detect && pendingBody !== undefined) {
        const { frontmatter: restoreFrontmatter } = stripFrontmatter(detect.baselineFullMd);
        reportPairedDeriveLoss(
          detect,
          pendingBody,
          parsedJson,
          xmlFragment,
          restoreFrontmatter,
          buildParseOpts(embedResolver),
        );
      }
    },
  );
}

export function replaceRawBody(
  document: Y.Doc,
  rawContent: string,
  embedResolver?: EmbedResolverArg,
  precomputed?: PrecomputedParse,
  detect?: DeriveLossDetectOptions,
): void {
  withSpanSync(
    'bridge.replaceRawBody',
    {
      attributes: {
        'body.bytes': rawContent.length,
        'doc.name': document.guid,
      },
    },
    () => {
      const xmlFragment = document.getXmlFragment('default');
      const ytext = document.getText('source');

      const parsedJson = parseBodyWithPrecompute(document, rawContent, embedResolver, precomputed);
      const pmNode = schema.nodeFromJSON(parsedJson);

      const pendingBody = detect ? serializeFragmentBody(xmlFragment) : undefined;

      const currentText = ytext.toString();
      if (currentText !== rawContent) {
        ytext.delete(0, currentText.length);
        ytext.insert(0, rawContent);
      }

      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(document, xmlFragment, pmNode, meta);

      if (detect && pendingBody !== undefined) {
        const { frontmatter: restoreFrontmatter } = stripFrontmatter(detect.baselineFullMd);
        reportPairedDeriveLoss(
          detect,
          pendingBody,
          parsedJson,
          xmlFragment,
          restoreFrontmatter,
          buildParseOpts(embedResolver),
        );
      }
    },
  );
}

/**
 * Pre-state contract: `Y.UndoManager.undo()` has already mutated ytext to the post-undo bytes
 * (those bytes ARE the user's intended post-undo source form per Y.Text-is-truth, precedent #38).
 */
export function deriveFragmentFromYtext(
  document: Y.Doc,
  embedResolver?: EmbedResolverArg,
  detect?: DeriveLossDetectOptions,
): void {
  const xmlFragment = document.getXmlFragment('default');
  const ytext = document.getText('source');

  const fullMd = ytext.toString();
  const { frontmatter, body } = stripFrontmatter(fullMd);
  const parseOpts = buildParseOpts(embedResolver);
  const parsedJson = mdManager.parseWithFallback(body, parseOpts);
  const pmNode = schema.nodeFromJSON(parsedJson);

  const pendingBody = detect
    ? mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON())
    : undefined;

  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(document, xmlFragment, pmNode, meta);

  if (detect && pendingBody !== undefined) {
    const rebuiltBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    const ytextDerivedBody = mdManager.serialize(parsedJson as JSONContent);
    const { body: baselineRawBody } = stripFrontmatter(detect.baselineFullMd);
    const baselineBody = mdManager.serialize(
      mdManager.parseWithFallback(baselineRawBody, parseOpts),
    );
    detect.report({
      pendingBody,
      baselineBody,
      ytextDerivedBody,
      rebuiltBody,
      restorePayload: composeWithDerivedBody(frontmatter, pendingBody).md,
    });
  }
}
