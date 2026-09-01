/**
 * Three sibling write-side primitives for the Y.Text-is-truth contract
 * (precedent #38). Each primitive owns one paired-write semantics — its
 * name is the contract.
 *
 *   - `composeAndWriteRawBody` — file-watcher + agent-write: parse → ytext-
 *     first `applyFastDiff` → fragment derive. Line-aligned diff preserves
 *     unrelated whole-line Y.Text Items + their origins; changed lines land
 *     as fresh contiguous runs (stale-anchor interleave safety).
 *   - `replaceRawBody` — rollback: parse → ytext-first FULL OVERWRITE
 *     (delete(0, len) + insert(0, raw)) → fragment derive. The non-
 *     incremental replacement is the load-bearing signal to Y.UndoManager
 *     that "this is a rollback, not an edit"; diff-based application would
 *     over-preserve Items the user explicitly rolled back.
 *   - `deriveFragmentFromYtext` — agent-undo: `Y.UndoManager.undo()` has
 *     already mutated ytext to the post-undo state; this primitive ONLY
 *     derives the fragment from `parse(ytext.toString())`. Writes zero
 *     bytes to ytext.
 *
 * Atomicity boundary: NO primitive calls
 * `doc.transact()`. The caller wraps so:
 *   1. Both halves of the cross-CRDT write (XmlFragment + Y.Text) are atomic
 *      from the perspective of any other observer.
 *   2. The per-session frozen origin object identity (precedent #24)
 *      survives — Y.UndoManager's `trackedOrigins` Set membership and the
 *      paired-write origin guard in server-observers both rely on object
 *      identity, not structural equality. A nested `doc.transact()` here
 *      would lose origin identity.
 *
 * Y.Text is the source-of-truth for user-intended source bytes.
 * Bytes that enter via these primitives land verbatim, modulo only the
 * equivalence classes enumerated in `normalizeBridge` — and even those are
 * TOLERATED at compare time, never WRITTEN at apply time.
 *
 * Write-order rationale (uniform across all three primitives that mutate
 * ytext): Y.Text receives bytes FIRST, then fragment derives. Yjs
 * transactions don't roll back on throw, so a partial failure mid-call
 * leaves whichever side wrote last in the new state and the other side
 * stale. Under the contract (Y.Text-is-truth), Y.Text is the source of
 * truth — if the ytext write succeeds and `updateYFragment` then throws,
 * ytext holds the correct user bytes and the next non-paired observer
 * dispatch re-derives fragment via `parse(ytext)`. Reversed order would
 * leave fragment correct and ytext stale — and Observer B Phase 1 on the
 * next non-paired ytext mutation would re-derive fragment from the STALE
 * ytext bytes, silently reverting the write.
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
 * Apply raw composed bytes to Y.Text via an incremental line-aligned diff and derive
 * XmlFragment via parse.
 *
 * MUST be called inside an outer `doc.transact(..., origin)` block
 * established by the caller (atomicity + per-session frozen origin object
 * identity per precedent #24).
 *
 * Bytes flow:
 *   - `ytext` receives `rawContent` verbatim via `applyFastDiff`
 *     (line-aligned diff, item-preserving for unchanged lines) — NO
 *     canonicalization. Run
 *     FIRST per the file-level write-order rationale.
 *   - `xmlFragment` receives `parse(body-without-FM)` via
 *     `updateYFragment` (item-preservation aware structural diff,
 *     precedent #11(a)). Derived SECOND.
 *
 * @param document Y.Doc holding the doc's `default` XmlFragment and `source` Y.Text.
 * @param rawContent Full document bytes (frontmatter + body) to write to Y.Text verbatim.
 * @param embedResolver `![[file.ext]]` resolver context, or `false` to opt out for pre-composed-bytes callers.
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
 * Derive XmlFragment from Y.Text — the agent-undo semantics.
 *
 * Pre-state contract: `Y.UndoManager.undo()` has already mutated ytext to
 * the post-undo bytes (those bytes ARE the user's intended post-undo
 * source form per Y.Text-is-truth, precedent #38). This primitive does
 * NOT mutate ytext; it ONLY parses ytext's current bytes and updates the
 * fragment so the structural diff preserves user-content Items at
 * matching positions.
 *
 * NO canonicalize-write-back step: re-serializing the fragment and
 * applying that back to ytext would canonicalize user-typed source-form
 * bytes (`__foo__` → `**foo**`, `:---:` widths, ATX trailing hashes,
 * setext underline length) and defeat the contract.
 *
 * MUST be called inside an outer `doc.transact(..., origin)` block
 * (typically `session.undoOrigin`).
 *
 * @param document Y.Doc holding the doc's `default` XmlFragment and `source` Y.Text.
 * @param embedResolver Optional `![[file.ext]]` resolver context.
 * @param detect Optional post-condition observer. When supplied, the pre-derive
 *   fragment is serialized (the at-risk content) and, after the rebuild,
 *   `detect.report` is invoked with the canonical before/after representations
 *   so a caller can checkpoint + observe content the rebuild discarded. The
 *   serialize cost is paid ONLY when a detector is wired.
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
