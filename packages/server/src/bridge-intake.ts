/**
 * Three sibling write-side primitives for the Y.Text-is-truth contract
 * (precedent #38). Each primitive owns one paired-write semantics — its
 * name is the contract.
 *
 *   - `composeAndWriteRawBody` — file-watcher + agent-write: parse → ytext-
 *     first `applyFastDiff` → fragment derive. Character-level DMP preserves
 *     unrelated Y.Text Items + their origins.
 *   - `replaceRawBody` — rollback: parse → ytext-first FULL OVERWRITE
 *     (delete(0, len) + insert(0, raw)) → fragment derive. The non-
 *     incremental replacement is the load-bearing signal to Y.UndoManager
 *     that "this is a rollback, not an edit"; DMP-based diff would over-
 *     preserve Items the user explicitly rolled back.
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
import { applyFastDiff, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { updateYFragment } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mdManager, schema } from './md-manager.ts';
import { withSpanSync } from './telemetry.ts';

/**
 * Embed-resolver context threaded through `mdManager.parseWithFallback`
 * so `![[photo.png]]` wiki-embed refs resolve to the right disk path
 * before PM dispatch. Same shape both intake surfaces accept.
 *
 * `resolveSize` returns the byte size of the resolved file for
 * `FILE_ATTACHMENT_EXTENSIONS` wikilinks (`.pdf` / `.docx` / `.zip` / …)
 * so the File row's size span survives reloads. Optional — call sites
 * that don't have fs access (or don't care about size resolution) leave
 * it undefined and the parser's wikiLinkEmbed handler omits the `size`
 * prop on the resulting jsxComponent.
 */
interface EmbedResolverContext {
  resolveEmbed: (basename: string, sourcePath: string) => string | null;
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  sourcePath: string;
}

/**
 * `false` opts out explicitly: the caller composes its own bytes and does
 * NOT want `parseWithFallback` to re-resolve `![[file.ext]]` references.
 * Functionally equivalent to `undefined`; the `false` literal makes the
 * opt-out auditable at call sites (managed-rename ships pre-composed bytes
 * via `applyRenameMap`).
 */
type EmbedResolverArg = EmbedResolverContext | false | undefined;

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

/**
 * Apply raw composed bytes to Y.Text via incremental DMP diff and derive
 * XmlFragment via parse.
 *
 * MUST be called inside an outer `doc.transact(..., origin)` block
 * established by the caller (atomicity + per-session frozen origin object
 * identity per precedent #24).
 *
 * Bytes flow:
 *   - `ytext` receives `rawContent` verbatim via `applyFastDiff`
 *     (character-level DMP, item-preserving) — NO canonicalization. Run
 *     FIRST per the file-level write-order rationale.
 *   - `xmlFragment` receives `parse(body-without-FM)` via
 *     `updateYFragment` (item-preservation aware structural diff,
 *     precedent #11(a)). Derived SECOND.
 *
 * @param document Y.Doc holding the doc's `default` XmlFragment and `source` Y.Text.
 * @param rawContent Full document bytes (frontmatter + body) to write to Y.Text verbatim.
 * @param embedResolver `![[file.ext]]` resolver context, or `false` to opt out for pre-composed-bytes callers.
 */
/**
 * Surface tag for `composeAndWriteRawBody`. Required, no fallback: every
 * call site declares its bridge-write context so the
 * `bridge.composeAndWriteRawBody` span attribute carries semantically
 * useful provenance for OTLP queries.
 *
 * Live values:
 *   - `'agent'` — `applyAgentMarkdownWrite` in `agent-sessions.ts`.
 *   - `'file-watcher'` — `applyDiskContentToDoc` in `external-change.ts`.
 *   - `'managed-rename'` — `_applyManagedRenameRewrite` in
 *     `api-extension.ts`. Composes pre-rewritten bytes via
 *     `applyRenameMap` and ships them through the substrate; opts out of
 *     embed re-resolution since bytes are already final.
 *
 * Reserved (no current call site; kept as forward-compat slots so a
 * future path-unification can adopt the surface without a type-shape
 * change):
 *   - `'undo'` — agent-undo currently uses direct primitives via
 *     `applyAgentUndo` → `deriveFragmentFromYtext`, not this compose path.
 *   - `'frontmatter'` — property-panel writes use `bindFrontmatterDoc`
 *     (Y.Text-only, paired:false), not this compose path.
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

      // Fragment derives from BODY (without FM): the markdown parser only handles
      // body markdown. FM lives in the YAML region of Y.Text directly — the
      // fragment side never carries it.
      const { body } = stripFrontmatter(rawContent);
      const parsedJson = withSpanSync(
        'md.parseWithFallback',
        { attributes: { 'body.bytes': body.length, 'doc.name': document.guid } },
        () => mdManager.parseWithFallback(body, buildParseOpts(embedResolver)),
      );
      const pmNode = schema.nodeFromJSON(parsedJson);

      // Y.Text gets the raw bytes FIRST, then fragment derives. The order matters:
      // Yjs transactions don't roll back on throw, so a partial failure mid-call
      // leaves whichever side wrote last in the new state and the other side stale.
      // Under the contract (precedent #38, Y.Text-is-truth), Y.Text is the source
      // of truth — if applyFastDiff succeeds and updateYFragment then throws,
      // ytext holds the correct user bytes and the next non-paired observer
      // dispatch re-derives fragment via parse(ytext). Reversed order would leave
      // fragment correct and ytext stale — and Observer B Phase 1 on the next
      // non-paired ytext mutation would re-derive fragment from the STALE ytext
      // bytes, silently reverting the write.
      //
      // Both writes happen inside the caller's outer transact for atomicity and
      // to share one origin object. applyFastDiff is character-level DMP that
      // preserves unrelated Y.Text Items + their origins; updateYFragment is
      // item-preservation aware (precedent #11(a)).
      if (currentYText !== rawContent) {
        applyFastDiff(ytext, currentYText, rawContent);
      }

      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(document, xmlFragment, pmNode, meta);
    },
  );
}

/**
 * Replace the entire Y.Text contents with `rawContent` via delete/insert
 * and derive XmlFragment via parse — the atomic-overwrite semantics.
 *
 * The full overwrite (vs `applyFastDiff`'s incremental DMP) is the load-
 * bearing signal to `Y.UndoManager` that this is a non-incremental
 * replacement: the caller discards the user's recent edits, so DMP-based
 * Item preservation would defeat the contract by re-using Items the
 * writer explicitly overwrote.
 *
 * Callers:
 *   - `handleRollback` under `ROLLBACK_ORIGIN` — restore a historical version.
 *   - `applyAgentMarkdownWrite(..., 'replace')` under per-session
 *     `session.origin` — agent atomic full overwrite.
 *
 * MUST be called inside the caller's outer `doc.transact(..., origin)`
 * block. The caller's origin determines `Y.UndoManager` attribution and
 * the paired-write fast-path in `server-observers`.
 *
 * @param document Y.Doc holding the doc's `default` XmlFragment and `source` Y.Text.
 * @param rawContent Full document bytes (frontmatter + body) to write to Y.Text verbatim.
 * @param embedResolver Optional `![[file.ext]]` resolver context.
 */
export function replaceRawBody(
  document: Y.Doc,
  rawContent: string,
  embedResolver?: EmbedResolverArg,
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

      const { body } = stripFrontmatter(rawContent);
      const parsedJson = mdManager.parseWithFallback(body, buildParseOpts(embedResolver));
      const pmNode = schema.nodeFromJSON(parsedJson);

      const currentText = ytext.toString();
      if (currentText !== rawContent) {
        ytext.delete(0, currentText.length);
        ytext.insert(0, rawContent);
      }

      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(document, xmlFragment, pmNode, meta);
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
 */
export function deriveFragmentFromYtext(document: Y.Doc, embedResolver?: EmbedResolverArg): void {
  const xmlFragment = document.getXmlFragment('default');
  const ytext = document.getText('source');

  const fullMd = ytext.toString();
  const { body } = stripFrontmatter(fullMd);
  const parsedJson = mdManager.parseWithFallback(body, buildParseOpts(embedResolver));
  const pmNode = schema.nodeFromJSON(parsedJson);

  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(document, xmlFragment, pmNode, meta);
}
