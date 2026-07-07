import { ChunkedInsertError, HtmlPayloadTooLargeError } from '@inkeep/open-knowledge-core';
import type { UrlPortabilityReason } from './clipboard-sanitize.ts';
import type { ClipboardSource } from './detect-source.ts';

/**
 * Performance + source-detection instrumentation.
 *
 * Structured JSON `console.warn` — shape mirrors existing
 * `mdx-block-fallback` / `unknown-mdast-type` events in the repo
 * (packages/core/src/markdown/parse-with-fallback.ts:36,59,69). Field
 * names are camelCase to match the codebase-wide convention for
 * structured events (`originalSpan`, `regionSize`, `originalType`, etc.).
 *
 * ## Event names
 *
 * Telemetry event names are a contract — dashboards and alert rules key
 * off exact strings. Every `clipboard-*` event uses a past-tense suffix
 * so the namespace has one convention (matches `clipboard-source-detected`
 * and `clipboard-chunked-insert-failed`). The `ClipboardEventName` literal
 * union below is the canonical list — adding a new event requires adding
 * a key here.
 *
 * ## Cardinality
 *
 * The `source`, `branch`, `stage`, `kind`, `op`, `view`, `tag`, `class`,
 * `reason`, and `phase` fields are typed as literal unions rather than
 * `string` so a typo at a call site becomes a compile error. This also
 * gives log-aggregator dashboards a static schema to render against.
 *
 * ## Event shapes
 *
 *   { event: 'clipboard-slow-op', op, view, elapsedMs, branch, source,
 *     htmlBytes? }
 *   { event: 'clipboard-source-detected', view, source, branch }
 *   { event: 'clipboard-html-conversion-failed', view, stage, source,
 *     reason, htmlBytes? }
 *   { event: 'clipboard-serialize-failed', view, kind, reason }
 *   { event: 'clipboard-chunked-insert-failed', view, chunksCompleted,
 *     totalChunks, bytesWritten, bytesRemaining, reason }
 *   { event: 'clipboard-walker-url-source-emitted', view, tag, class,
 *     reason }
 *   { event: 'clipboard-walker-url-classifier-failed', view, tag,
 *     phase, errorClass? }
 *
 * `clipboard-source-detected` intentionally does NOT carry `htmlBytes` —
 * the value has unbounded cardinality. Size distributions live on
 * `clipboard-slow-op` instead, which only fires above threshold.
 */

/**
 * Exhaustive list of telemetry events the clipboard module emits. New
 * events must be added here first — downstream consumers treat this as
 * the source of truth for dashboard + alert configuration.
 */
type ClipboardEventName =
  | 'clipboard-slow-op'
  | 'clipboard-source-detected'
  | 'clipboard-html-conversion-failed'
  | 'clipboard-serialize-failed'
  | 'clipboard-chunked-insert-failed'
  // Reserved: emitted by `descriptor.toClipboardHast` override invocations
  // when the first descriptor with hidden state declares one. The current
  // descriptor set (5-pack + 3 compat) all use the walker default, which is
  // intentionally NOT instrumented (would explode telemetry volume on
  // every copy). The helper that emits this event lands with the first
  // override; the name is registered here so dashboards know it exists.
  | 'clipboard-hast-override-invoked'
  // Emitted when the live-DOM walker hits `view.nodeDOM(pos) === null`
  // and falls back to the per-descriptor static palette. Expected only
  // for Activity-hidden subtrees; presence in normal copy operations
  // signals a real bug per the walker STOP_IF rule.
  | 'clipboard-walker-fallback-fired'
  // Emitted when the live-DOM walker drops or rewrites a value at the
  // cross-app re-emit escape boundary — unsafe URL scheme on `href`/`src`/
  // `srcset`/..., dangerous `on*` event-handler attribute, unsafe
  // `url(javascript:...)` / `expression(...)` payload in `style`, or an
  // embedded unsafe URL inside `aria-label`/`title` that was substituted
  // with `[blocked]`. Cardinality bounded: `attr` is one of the
  // URL_SCHEME_ATTRS / URL_BEARING_TEXT_ATTRS members or the literal
  // `style` / `on*`; `reason` is a fixed taxonomy.
  | 'clipboard-walker-url-blocked'
  // Emitted at most once per process per `lucide-*` class when the walker
  // encounters a lucide SVG icon with no glyph mapping in
  // `LUCIDE_GLYPH_MAP`. Surface so a new descriptor that ships an icon
  // without a corresponding glyph entry doesn't silently regress cross-app
  // paste fidelity (the SVG stays as inline `<svg>` which every major
  // destination strips). Cardinality bounded by the lucide-icons set and
  // dedup'd per process.
  | 'clipboard-walker-unmapped-lucide-detected'
  // Emitted when the live-DOM walker URL-portability classifier detects a
  // non-portable URL on a URL-bearing element (`img`/`video`/`audio`/
  // `source`/`a`/`picture`) and swaps the element to a source-fallback
  // shape (`<pre class="mdx-component">` block or `<span class="mdx-inline">`
  // inline). Cross-app destinations show informative markdown source
  // instead of a broken-image icon. Cardinality bounded: `tag` × `class` ×
  // `reason` = 6 × 2 × 5 = 60 combos.
  | 'clipboard-walker-url-source-emitted'
  // Emitted when the live-DOM walker swaps a non-portable RENDER (KaTeX
  // span tree, mermaid SVG, non-image wikiLinkEmbed chip) to a markdown
  // source-fallback shape. Two call sites: walker entry-point dispatch
  // via `nonPortableRenderSourceFallback` (block-level Math + MermaidFence
  // jsxComponents) and post-clone pass via
  // `applyNonPortableInlineAtomReplacement` (inline `mathInline` atoms
  // + non-image `wikiLinkEmbed` atoms — PDF / video / audio chips).
  // Distinct from `clipboard-walker-url-source-emitted` (URL portability
  // — orthogonal concern). Cardinality bounded: `descriptor` is one of
  // {Math, MermaidFence, mathInline, wikiLinkEmbed}; `view` is a fixed enum.
  | 'clipboard-walker-non-portable-render-source-emitted'
  // Emitted when the URL-portability classifier or the source-markdown
  // serializer fails for a URL-bearing element. The walker preserves the
  // element unchanged in either case so the user's content is never lost;
  // this event is the operability signal that surfaces the failure for
  // follow-up. The `phase` discriminator separates the three failure modes
  // an operator must triage differently:
  //   - `'classifier-throw'` — `classifyUrlPortability` raised on a URL
  //     `isRelativeUrl` couldn't reject. Indicates a malformed URL or
  //     classifier bug; carries `errorClass` from `classifyError(err)`.
  //   - `'serializer-null'` — the live element has no PM correspondence
  //     (`nodeAt` returned null). Expected at low baseline rate during
  //     `<Activity>` flips; no errorClass because there was no throw.
  //   - `'serializer-throw'` — a step in the serializer chain threw
  //     (`posAtDOM` RangeError on a detached element, or
  //     `mdManager.serialize` on a corrupted slice). Carries `errorClass`
  //     so a markdown-pipeline regression (content-loss class) is
  //     distinguishable from baseline async-detach noise.
  // Cardinality bounded by `tag` × `phase` (× `errorClass` taxonomy).
  | 'clipboard-walker-url-classifier-failed';

/** View identifier — one per clipboard-bearing editor surface. */
type ClipboardView = 'wysiwyg' | 'source';

/**
 * Operation that triggered the event. `drop` mirrors `paste` — the same
 * dispatcher runs against `event.dataTransfer` instead of
 * `event.clipboardData`, so telemetry distinguishes the two surfaces.
 */
type ClipboardOp = 'copy' | 'cut' | 'paste' | 'drop';

/**
 * Dispatcher branch the event was emitted from. `A`–`E` match the WYSIWYG
 * paste dispatcher and source paste dispatcher. Source's `B-wrapper` and
 * Branch B both collapse into CM6's text/plain default, but stay distinct
 * in telemetry. `shift` is the Cmd+Shift+V escape hatch; `codeblock` is the
 * cursor-inside-code short-circuit; `serialize` is the copy/cut path where
 * the concept of "paste branch" doesn't apply.
 */
export type ClipboardBranch =
  | 'A'
  | 'B-wrapper'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'shift'
  | 'codeblock'
  | 'serialize';

/**
 * Pipeline stage that produced a conversion failure. `htmlToMdast` is the
 * rehype walk; `mdastToMarkdown` is remark-stringify; `mdManagerParse` is
 * the markdown → PM conversion; `applyJsonSlice` is the PM dispatch;
 * `branchA` is the VS-Code-fenced-block path; `chunkedYTextInsert` is the
 * partial-insert failure (also surfaces as the typed `ChunkedInsertError`).
 */
type ClipboardStage =
  | 'htmlToMdast'
  | 'mdastToMarkdown'
  | 'mdManagerParse'
  | 'applyJsonSlice'
  | 'branchA'
  | 'chunkedYTextInsert';

/** Serialization path — `text` is text/plain, `html` is text/html. */
type SerializeKind = 'text' | 'html';

interface ClipboardTiming {
  op: ClipboardOp;
  view: ClipboardView;
  branch: ClipboardBranch;
  source: ClipboardSource;
  htmlBytes?: number;
}

interface ClipboardLogEvent {
  op?: ClipboardOp;
  view: ClipboardView;
  branch: ClipboardBranch;
  source: ClipboardSource;
}

interface ConversionFailInfo {
  view: ClipboardView;
  /** Which stage of the pipeline threw. */
  stage: ClipboardStage;
  /** Vendor source identifier as produced by `detectSource` (gdocs/gmail/notion/etc.) — kept as a separate dimension from `branch` so Datadog/Loki queries can filter on either axis independently. */
  source: ClipboardSource;
  /** Dispatcher branch label the stage was running inside. Optional: copy-side serializers do not have branches. */
  branch?: ClipboardBranch;
  /** Error message — free-text, use for human debugging. */
  reason: string;
  /** Optional typed error class (e.g. `HtmlPayloadTooLargeError`) so aggregators can distinguish expected-large-input from bug-class failures without string-matching `reason`. */
  errorClass?: string;
  htmlBytes?: number;
}

interface SerializeFailInfo {
  view: ClipboardView;
  kind: SerializeKind;
  reason: string;
}

interface ChunkedInsertFailInfo {
  view: ClipboardView;
  chunksCompleted: number;
  totalChunks: number;
  bytesWritten: number;
  bytesRemaining: number;
  reason: string;
}

const SLOW_PASTE_MS = 250;
const SLOW_COPY_MS = 100;

/**
 * Log `clipboard-slow-op` when an operation exceeds its threshold
 * (250ms for paste/drop, 100ms for copy). No log for fast ops. Drop
 * shares the paste budget because it runs the same dispatcher (markdown
 * parse + PM tree apply) over an equivalent payload.
 */
export function logIfSlow(start: number, timing: ClipboardTiming): void {
  const elapsed = performance.now() - start;
  const threshold = timing.op === 'paste' || timing.op === 'drop' ? SLOW_PASTE_MS : SLOW_COPY_MS;
  if (elapsed < threshold) return;
  console.warn(
    JSON.stringify({
      event: 'clipboard-slow-op' satisfies ClipboardEventName,
      op: timing.op,
      view: timing.view,
      elapsedMs: Math.round(elapsed),
      branch: timing.branch,
      source: timing.source,
      ...(timing.htmlBytes != null ? { htmlBytes: timing.htmlBytes } : {}),
    }),
  );
}

/**
 * Log `clipboard-source-detected` once per paste event — useful for
 * tracking which vendor sources our users actually paste from.
 *
 * Does not carry payload size: cardinality-safe dimensions only.
 */
export function logSourceDetected(ev: ClipboardLogEvent): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-source-detected' satisfies ClipboardEventName,
      view: ev.view,
      source: ev.source,
      branch: ev.branch,
    }),
  );
}

/**
 * Emit when a pipeline stage throws and the dispatcher falls through to
 * the next branch. Aggregators derive failure rates from this event.
 */
export function logConversionFail(info: ConversionFailInfo): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-html-conversion-failed' satisfies ClipboardEventName,
      view: info.view,
      stage: info.stage,
      source: info.source,
      ...(info.branch != null ? { branch: info.branch } : {}),
      reason: info.reason,
      ...(info.errorClass != null ? { errorClass: info.errorClass } : {}),
      ...(info.htmlBytes != null ? { htmlBytes: info.htmlBytes } : {}),
    }),
  );
}

/**
 * Emit when the copy-side serializer fails and the dispatcher falls back
 * to a degraded path (textBetween / default DOMSerializer).
 */
export function logSerializeFail(info: SerializeFailInfo): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-serialize-failed' satisfies ClipboardEventName,
      view: info.view,
      kind: info.kind,
      reason: info.reason,
    }),
  );
}

/**
 * Emit when the live-DOM clipboard walker hits a `null` from
 * `view.nodeDOM(pos)` and falls back to the per-descriptor static palette.
 * Expected behavior for Activity-hidden subtrees; presence on a top-level
 * descriptor in a normally-mounted editor signals a real bug per the
 * walker STOP_IF rule. Bounded-cardinality: `descriptor` is a PM node
 * type name (statically defined) and `view` is a fixed enum.
 */
export function logWalkerFallback(info: { descriptor: string; view: ClipboardView }): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-fallback-fired' satisfies ClipboardEventName,
      descriptor: info.descriptor,
      view: info.view,
    }),
  );
}

/**
 * Emit when the live-DOM walker swaps a non-portable rendering for a
 * markdown source-fallback shape. Two call sites:
 *   - Walker entry-point dispatch via `nonPortableRenderSourceFallback`
 *     for top-level `jsxComponent` nodes whose `componentName` is
 *     `Math` or `MermaidFence`.
 *   - Post-clone pass via `applyNonPortableInlineAtomReplacement` for
 *     inline `mathInline` PM atoms and non-image `wikiLinkEmbed` atoms
 *     (PDF / video / audio chips) within paragraphs.
 *
 * Bounded-cardinality: `descriptor` is one of `{Math, MermaidFence,
 * mathInline, wikiLinkEmbed}` (statically defined); `view` is a fixed
 * enum. Adding a new non-portable-render source-fallback path requires
 * an explicit source name added to the call site's value.
 */
export function logNonPortableRenderSourceEmitted(info: {
  descriptor: string;
  view: ClipboardView;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-non-portable-render-source-emitted' satisfies ClipboardEventName,
      descriptor: info.descriptor,
      view: info.view,
    }),
  );
}

/**
 * Reasons the walker rejected an attribute or value at the cross-app
 * re-emit escape boundary. Bounded enum so log-aggregator dashboards can
 * render a static schema; `attr` is constrained at the call site to
 * URL_SCHEME_ATTRS / URL_BEARING_TEXT_ATTRS members or the literal
 * `style` / `on*`.
 */
type WalkerUrlBlockedReason =
  | 'scheme'
  | 'srcset-candidate'
  | 'embedded-url'
  | 'event-handler'
  | 'unsafe-url-or-expression';

/**
 * Emit when the walker drops or rewrites a value at the cross-app re-emit
 * escape boundary. Defense-in-depth — sibling sanitizers
 * (`sanitize-url.ts:emitPropDroppedEvent`) emit on the same cadence, so
 * attack-surface visibility is symmetric across the codebase.
 */
export function logWalkerUrlBlocked(info: {
  attr: string;
  reason: WalkerUrlBlockedReason;
  view: ClipboardView;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-url-blocked' satisfies ClipboardEventName,
      view: info.view,
      attr: info.attr,
      reason: info.reason,
    }),
  );
}

/**
 * Tags in scope for the URL-portability classifier (leaf scope +
 * `<picture>`-as-unit). Literal union — every emitter call site is
 * compile-checked, so a typo or scope expansion shows up at the type
 * boundary. Expanding the scope is an architectural decision that
 * touches this union AND the walker's `URL_LEAF_TAGS` set together.
 */
export type WalkerUrlSourceTag = 'img' | 'video' | 'audio' | 'source' | 'a' | 'picture';

/**
 * Source-fallback emission shape selected by the walker — block (`<pre
 * class="mdx-component">`) for flow-context elements, inline (`<span
 * class="mdx-inline">`) for paragraph-content elements per HTML5 content
 * model. No `data-jsx-inline` round-trip marker is emitted: cross-app
 * destinations don't need it and OK→OK paste is structurally protected
 * by the markdown-first dispatcher tiebreak.
 */
export type WalkerUrlSourceClass = 'mdx-component' | 'mdx-inline';

/**
 * Phase discriminator for `clipboard-walker-url-classifier-failed`.
 *
 *   - `'classifier-throw'` — `classifyUrlPortability` threw on a URL the
 *     short-circuit didn't reject (malformed input, classifier bug). The
 *     event also carries `errorClass` from `classifyError(err)`.
 *   - `'serializer-null'` — the live element has no PM correspondence
 *     (`nodeAt` returned null). Expected at low baseline rate while
 *     `<Activity>` flips; no errorClass because there was no throw.
 *   - `'serializer-throw'` — a step in the serializer chain threw
 *     (`posAtDOM` RangeError on detached element, `mdManager.serialize`
 *     on a corrupted slice). Carries `errorClass` so a markdown-pipeline
 *     regression is distinguishable from baseline async-detach noise.
 */
type WalkerUrlClassifierFailedPhase = 'classifier-throw' | 'serializer-null' | 'serializer-throw';

/**
 * Emit when the live-DOM walker URL-portability classifier detects a
 * non-portable URL on a URL-bearing element and swaps the element to a
 * source-fallback emission shape. The pair `(tag, class, reason)` segments
 * dashboards along the three axes that matter: which element types most
 * often carry non-portable URLs, which emission shape was selected, and
 * which URL shape the user authored. The sister palette path emits the
 * same event from the fallback emission site (Activity-hidden subtrees).
 */
export function logWalkerUrlSourceEmitted(info: {
  view: ClipboardView;
  tag: WalkerUrlSourceTag;
  class: WalkerUrlSourceClass;
  reason: UrlPortabilityReason;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-url-source-emitted' satisfies ClipboardEventName,
      view: info.view,
      tag: info.tag,
      class: info.class,
      reason: info.reason,
    }),
  );
}

/**
 * Emit when the walker preserves a URL-bearing element unchanged because
 * either the URL classifier threw OR the source-markdown serializer
 * could not produce bytes for the element. The user's content is never
 * lost — this event is the operability signal that surfaces the failure
 * so a classifier bug, malformed URL, detached DOM, or PM/serializer
 * regression doesn't go silent.
 *
 * The `phase` discriminator separates the three failure modes operators
 * triage differently — see {@link WalkerUrlClassifierFailedPhase}.
 *
 * Target rate <0.1% of `clipboard-walker-url-source-emitted` event
 * volume; rates above that threshold should alert.
 */
export function logWalkerUrlClassifierFailed(info: {
  view: ClipboardView;
  tag: WalkerUrlSourceTag;
  phase: WalkerUrlClassifierFailedPhase;
  errorClass?: string;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-url-classifier-failed' satisfies ClipboardEventName,
      view: info.view,
      tag: info.tag,
      phase: info.phase,
      ...(info.errorClass != null ? { errorClass: info.errorClass } : {}),
    }),
  );
}

/**
 * Emit at most once per process per unmapped `lucide-*` class. Module-level
 * Set provides the dedup; bounded above by the lucide icon set (~1500
 * names). Triggered from `replaceLucideIconsWithGlyphs` in clipboard-walker.ts
 * when a descriptor's React render contains a lucide SVG that has no glyph
 * entry. Without this signal, a new icon shipped without a mapping would
 * silently disappear at every major paste destination (Gmail, Notion,
 * Slack, Outlook, Google Docs all strip inline SVG).
 *
 * Test-only reset hook: `resetUnmappedLucideSeenForTest` exists so unit
 * tests can clear the dedup set between assertions without paying the
 * cost of unique-class-per-test bookkeeping.
 */
const unmappedLucideSeen = new Set<string>();
export function logUnmappedLucideIcon(info: { lucideClass: string; view: ClipboardView }): void {
  if (unmappedLucideSeen.has(info.lucideClass)) return;
  unmappedLucideSeen.add(info.lucideClass);
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-unmapped-lucide-detected' satisfies ClipboardEventName,
      view: info.view,
      lucideClass: info.lucideClass,
    }),
  );
}

/** Test-only: reset the dedup state. Not exported via barrel. */
export function resetUnmappedLucideSeenForTest(): void {
  unmappedLucideSeen.clear();
}

/**
 * Emit when chunked Y.Text insertion fails mid-stream. Partial-progress
 * fields allow a UI layer to surface a non-modal "N of M chunks landed"
 * notice to the user.
 */
export function logChunkedInsertFail(info: ChunkedInsertFailInfo): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-chunked-insert-failed' satisfies ClipboardEventName,
      view: info.view,
      chunksCompleted: info.chunksCompleted,
      totalChunks: info.totalChunks,
      bytesWritten: info.bytesWritten,
      bytesRemaining: info.bytesRemaining,
      reason: info.reason,
    }),
  );
}

/**
 * Map an unknown thrown value to a stable class name for telemetry so
 * aggregators can distinguish expected-large-input (`HtmlPayloadTooLargeError`)
 * and partial-progress failures (`ChunkedInsertError`) from bug-class errors
 * without string-matching `reason`. Single source of truth for the
 * `errorClass` taxonomy — both clipboard dispatchers import from here so new
 * typed error classes need to be registered in exactly one place.
 *
 * Default `Error` name is elided: untyped `new Error(msg)` carries `name
 * === 'Error'` which provides no signal beyond what `reason` already
 * conveys. Typed subclasses (set via class constructor or explicit `name =`)
 * produce a discriminating value; untyped errors omit the field entirely.
 */
export function classifyError(err: unknown): string | undefined {
  if (err instanceof HtmlPayloadTooLargeError) return 'HtmlPayloadTooLargeError';
  if (err instanceof ChunkedInsertError) return 'ChunkedInsertError';
  if (err instanceof Error && err.name && err.name !== 'Error') return err.name;
  return undefined;
}
