/**
 * WYSIWYG markdown-lint decorations.
 *
 * Source mode shows lint diagnostics inline via `@codemirror/lint`. WYSIWYG has
 * no source lines to anchor to, so this extension marks the *block* each
 * diagnostic falls in: it lints the SAME `Y.Text('source')` bytes the Problems
 * panel and source mode lint (via the `getSource` option), re-parses the body
 * region to mdast for top-level block line spans, and maps each diagnostic's
 * source line onto the corresponding top-level PM node via a `Decoration.node`.
 *
 * Linting the raw source (not a re-serialization of the PM doc) is load-bearing:
 * serialization normalizes away exactly the byte-level constructs many rules
 * flag (hard tabs, trailing spaces, list-marker style, blank-line runs), so a
 * serialize-then-lint pass can never see them and WYSIWYG would silently show
 * fewer problems than the panel. The mdast children of `parse(body)` usually
 * line up 1:1 with the doc's top-level nodes; a mismatch is detected by
 * block-count comparison and the pass is dropped, not misanchored. The
 * mismatch is NOT always a mid-drain transient: a WYSIWYG-authored fragment
 * can hold top-level shapes markdown cannot spell and diverge persistently
 * (see the block-spans.ts module doc) — on such docs the dropped pass
 * persists too, and block lint stays absent until the fragment is re-derived
 * from bytes.
 *
 * Pool-safety: like `chunk-wrapper-decoration`, the plugin keys off `state.doc`
 * (PM structure), never `documentName`, and adds NO Y.js observer (the CLAUDE.md
 * STOP rule against unbounded observers in the Activity subtree). It recomputes
 * on a trailing debounce after real doc edits and on lint-config changes; the
 * heavy lint pass never runs on the keystroke hot path. Local-edit drain-back
 * latency (PM change → Observer A → Y.Text) is covered by a source-changed
 * re-check at the end of each pass rather than an observer.
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import {
  sharedExtensions as coreExtensions,
  type LintDiagnostic,
  type LinterConfig,
  type LintTextEdit,
  lintDocument,
  MarkdownManager,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import { buttonVariants } from '@/components/ui/button';
import { collectFixes, LINT_SOURCE_FIXED_EVENT } from '@/editor/apply-lint-fix';
import {
  clearPendingSourceNavigation,
  peekPendingSourceNavigation,
} from '@/editor/source-editor-navigation';
import { cn } from '@/lib/utils';
import { blockIndexForLine, comparableChildCount, computeSourceBlockSpans } from '../block-spans';
import { fetchEffectiveLintConfig, subscribeToLintConfigChanged } from '../lint-config-client';
import { runScrollNavigation } from '../scroll-restore-coordination';

const markdownLintDecorationKey = new PluginKey<DecorationSet>('markdownLintDecorations');

/** CSS classes consumed by `.ProseMirror .ok-lint-block*` in globals.css. */
const OK_LINT_BLOCK_CLASS = 'ok-lint-block';
const OK_LINT_BLOCK_ERROR_CLASS = 'ok-lint-block-error';
// Modifier for textless blocks (thematic break, image) — a wavy text-decoration
// is invisible with no text to underline, so these get an outline instead.
const OK_LINT_BLOCK_ATOM_CLASS = 'ok-lint-block-atom';

const RECOMPUTE_DEBOUNCE_MS = 400;

/**
 * Group diagnostics by the index of the top-level block they fall in.
 * `source` is the full document text (frontmatter included); diagnostics with
 * no body anchor are skipped — they stay visible in the Problems panel.
 *
 * Two kinds have no anchor. Anything reported INSIDE the frontmatter region
 * belongs to the property panel, not the body. And every `frontmatter`-source
 * diagnostic is anchorless regardless of where its line lands: the validator
 * anchors a missing-`required` violation to the region's opening fence, which
 * on a doc with NO frontmatter at all is line 1 — the first line of body text.
 * Line-based skipping alone therefore paints a squiggle on the one construct
 * that is definitionally not the problem (there is nothing there to be wrong),
 * on the docs where the error matters most. `isFrontmatterAnchorless` keys off
 * the producing plugin instead, which holds for both cases.
 */
function isFrontmatterAnchorless(diagnostic: LintDiagnostic): boolean {
  return diagnostic.source === 'frontmatter';
}

export function mapDiagnosticsToBlocks(
  source: string,
  diagnostics: LintDiagnostic[],
  md: MarkdownManager,
): Map<number, LintDiagnostic[]> {
  const byBlock = new Map<number, LintDiagnostic[]>();
  if (diagnostics.length === 0) return byBlock;
  const { spans, fmLineCount } = computeSourceBlockSpans(source, md);
  for (const diagnostic of diagnostics) {
    if (isFrontmatterAnchorless(diagnostic)) continue;
    // mdast positions are 1-based; the diagnostic range is 0-based LSP.
    const line = diagnostic.range.start.line + 1;
    if (fmLineCount > 0 && line <= fmLineCount) continue;
    const index = blockIndexForLine(spans, line);
    if (index === null) continue;
    const existing = byBlock.get(index);
    if (existing) existing.push(diagnostic);
    else byBlock.set(index, [diagnostic]);
  }
  return byBlock;
}

/** DOM attribute that carries a block's diagnostic lines for the hover tooltip. */
const LINT_TOOLTIP_ATTR = 'data-ok-lint';
/** Marks a decorated block whose diagnostics carry auto-fixable edits. */
const LINT_FIXABLE_ATTR = 'data-ok-lint-fixable';

/**
 * Build a node decoration per top-level block that carries ≥1 diagnostic, plus
 * a block-offset → auto-fix-edits map so the hover tooltip's Fix button can
 * apply a block's fixes without re-linting.
 */
function buildDecorationSet(
  doc: PmNode,
  byBlock: Map<number, LintDiagnostic[]>,
): { set: DecorationSet; fixesByOffset: Map<number, LintTextEdit[]> } {
  const fixesByOffset = new Map<number, LintTextEdit[]>();
  if (byBlock.size === 0) return { set: DecorationSet.empty, fixesByOffset };
  const decorations: Decoration[] = [];
  let blockIndex = 0;
  doc.forEach((node, offset) => {
    const diagnostics = byBlock.get(blockIndex);
    blockIndex += 1;
    if (!diagnostics || diagnostics.length === 0) return;
    const hasError = diagnostics.some((d) => d.severity === 'error');
    // One line per diagnostic; the hover tooltip renders these with line breaks.
    const tooltip = diagnostics.map((d) => `${d.source}/${d.code}: ${d.message}`).join('\n');
    // Textless top-level blocks (thematic break, block image) render no inline
    // text, so the base class's wavy text-decoration paints nothing — flag them
    // for the outline treatment in globals.css. The base class stays on so the
    // hover tooltip's `.ok-lint-block` lookup still matches.
    const classNames = [OK_LINT_BLOCK_CLASS];
    if (node.textContent.length === 0) classNames.push(OK_LINT_BLOCK_ATOM_CLASS);
    if (hasError) classNames.push(OK_LINT_BLOCK_ERROR_CLASS);
    const attrs: Record<string, string> = {
      class: classNames.join(' '),
      [LINT_TOOLTIP_ATTR]: tooltip,
    };
    const fixes = collectFixes(diagnostics);
    if (fixes.length > 0) {
      attrs[LINT_FIXABLE_ATTR] = '1';
      fixesByOffset.set(offset, fixes);
    }
    decorations.push(Decoration.node(offset, offset + node.nodeSize, attrs));
  });
  return { set: DecorationSet.create(doc, decorations), fixesByOffset };
}

/**
 * A hover tooltip for decorated lint blocks. The native `title` attribute is
 * slow, unstyled, and clipped; this renders an OK-popover-styled box on
 * pointer-enter of any `.ok-lint-block`, positioned just above the block. When
 * the block has auto-fixable diagnostics and `applyFix` is wired, it also shows
 * a Fix button (mouse-only convenience — the Problems panel is the
 * keyboard-accessible fix path). The tooltip stays open while the pointer is
 * over it so the button is reachable.
 *
 * Mouse-only is enforced rather than merely documented: any keydown in the
 * editor retires the tooltip, so an overlay raised by a resting pointer can
 * never stand over the region the user has started typing in.
 */
function createLintTooltip(
  view: EditorView,
  opts: {
    getFixes: (block: HTMLElement) => LintTextEdit[];
    applyFix?: (fixes: LintTextEdit[]) => void;
  },
): { destroy: () => void } {
  const tooltip = document.createElement('div');
  tooltip.className = 'ok-lint-tooltip';
  // Deliberately no `role="tooltip"`: pointer-triggered from non-focusable text
  // ranges with no aria-describedby association. The Problems panel is the
  // keyboard-accessible surface for the same diagnostics + fixes.
  tooltip.hidden = true;
  const message = document.createElement('div');
  message.className = 'ok-lint-tooltip-message';
  tooltip.appendChild(message);
  const fixButton = document.createElement('button');
  fixButton.type = 'button';
  // Styled by the shared shadcn button recipe so the imperative tooltip matches
  // React surfaces; `ok-lint-tooltip-fix` is a bare selector hook (tests +
  // the [hidden] guard in globals.css), not a styling class.
  fixButton.className = cn(
    'ok-lint-tooltip-fix',
    buttonVariants({ variant: 'default', size: 'xs' }),
    'mt-1 self-start',
  );
  fixButton.hidden = true;
  tooltip.appendChild(fixButton);
  // Body-appended, viewport-fixed: positioned by floating-ui against a virtual
  // reference built from the hovered line (below), so it survives editor scroll
  // containers.
  tooltip.style.position = 'fixed';
  tooltip.style.top = '0';
  tooltip.style.left = '0';
  document.body.appendChild(tooltip);

  let current: HTMLElement | null = null;
  let overTooltip = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let stopAutoUpdate: (() => void) | null = null;
  // Anchor for positioning: the pointer's x, but the full vertical extent of
  // the text line under it. Keeping the pointer's x holds the tooltip next to
  // the text being hovered (not at the block's top-left corner) even in a tall
  // block, while the line's height is what `offset()` measures its clearance
  // from — a zero-height reference clears the pointer POINT, which sits inside
  // the line the caret is on, so the box lands on top of the text being edited.
  let anchorX = 0;
  let anchorTop = 0;
  let anchorBottom = 0;
  const virtualEl = {
    getBoundingClientRect: () =>
      ({
        width: 0,
        height: anchorBottom - anchorTop,
        x: anchorX,
        y: anchorTop,
        top: anchorTop,
        left: anchorX,
        right: anchorX,
        bottom: anchorBottom,
      }) as DOMRect,
  };

  function cancelHide() {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function reallyHide() {
    cancelHide();
    current = null;
    tooltip.hidden = true;
    stopAutoUpdate?.();
    stopAutoUpdate = null;
  }

  // Grace delay: let the pointer traverse the small gap from the text to the
  // tooltip (to click Fix) without the tooltip vanishing mid-move.
  function scheduleHide() {
    if (overTooltip) return;
    cancelHide();
    hideTimer = setTimeout(reallyHide, 140);
  }

  function position() {
    computePosition(virtualEl, tooltip, {
      placement: 'top-start',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    })
      .then(({ x, y }) => {
        if (tooltip.isConnected) {
          tooltip.style.left = `${x}px`;
          tooltip.style.top = `${y}px`;
        }
      })
      .catch((err) => {
        if (tooltip.isConnected) {
          console.warn('[markdown-lint] tooltip computePosition failed', err);
        }
      });
  }

  function show(target: HTMLElement) {
    const text = target.getAttribute(LINT_TOOLTIP_ATTR);
    if (!text) {
      scheduleHide();
      return;
    }
    cancelHide();
    current = target;
    message.textContent = text;
    const fixes = opts.applyFix ? opts.getFixes(target) : [];
    if (fixes.length > 0 && opts.applyFix) {
      fixButton.hidden = false;
      fixButton.textContent = t`Fix`;
      fixButton.onclick = () => {
        opts.applyFix?.(fixes);
        overTooltip = false;
        reallyHide();
      };
    } else {
      fixButton.hidden = true;
      fixButton.onclick = null;
    }
    tooltip.hidden = false;
    stopAutoUpdate?.();
    // autoUpdate runs position() synchronously on setup (content already set) and
    // re-runs it on scroll/resize.
    stopAutoUpdate = autoUpdate(virtualEl, tooltip, position);
  }

  function onOver(event: Event) {
    const pe = event as PointerEvent;
    const target = event.target as HTMLElement | null;
    const block = target?.closest<HTMLElement>(`.${OK_LINT_BLOCK_CLASS}`) ?? null;
    if (block) {
      if (block !== current) {
        anchorX = pe.clientX;
        // A textless block has no text line to measure, so `coordsAtPos` hands
        // back a zero-height rect (`flattenH` in block context): its own top
        // edge for a plain leaf like a thematic break, but (0,0,0,0) for an
        // atom node view, whose position DOM is an empty, never-laid-out
        // element. The second would anchor the callout to the viewport origin
        // instead of to the block, so a collapsed measurement falls back to the
        // block's own box — the wider clearance, which is also what the
        // declared `| null` arm takes. That arm is unreachable from here by
        // construction (a lint block is a child of `view.dom`, and the null
        // arms require coords outside it).
        const found = view.posAtCoords({ left: pe.clientX, top: pe.clientY });
        const measured = found ? view.coordsAtPos(found.pos) : null;
        const line =
          measured && measured.bottom > measured.top ? measured : block.getBoundingClientRect();
        anchorTop = line.top;
        anchorBottom = line.bottom;
        show(block);
      } else {
        // Still over the same block — keep it alive (cancel any pending hide).
        cancelHide();
      }
    } else if (current) {
      scheduleHide();
    }
  }

  function onOut(event: Event) {
    const related = (event as PointerEvent).relatedTarget as HTMLElement | null;
    // Keep the tooltip open when the pointer moves onto it (so Fix is clickable).
    if (related === tooltip || related?.closest('.ok-lint-tooltip')) {
      cancelHide();
      return;
    }
    if (!related?.closest(`.${OK_LINT_BLOCK_CLASS}`)) scheduleHide();
  }

  function onTooltipEnter() {
    overTooltip = true;
    cancelHide();
  }
  function onTooltipLeave(event: Event) {
    overTooltip = false;
    const related = (event as PointerEvent).relatedTarget as HTMLElement | null;
    if (related !== current && !related?.closest(`.${OK_LINT_BLOCK_CLASS}`)) scheduleHide();
  }

  // Once the user is driving with the keyboard, an overlay raised by a pointer
  // they are no longer moving is an obstruction, so EVERY key retires it —
  // deliberately no key allowlist and no `overTooltip` grace. Any exclusion is a
  // hole (IME `229`, chorded shortcuts, a modifier held before a click), and the
  // cost of over-firing is one hover the user restores by moving off the block
  // and back — `pointerover` fires on boundary crossings, not on motion, so a
  // nudge in place does not re-raise it — while the cost of under-firing is a
  // box parked on the caret.
  // Clearing `overTooltip` alongside the hide mirrors what the Fix click does,
  // for the same reason: a hidden tooltip stops being hit-testable, so the
  // `pointerleave` that would normally clear the grace flag may never arrive,
  // and a stale flag makes the next `scheduleHide` return early. Defensive
  // rather than load-bearing on a spec-compliant engine — the boundary
  // algorithm dispatches `pointerleave` on the tooltip before any `pointerover`
  // that could re-raise it, so the stranded window is real but unreachable.
  function onKeyDown() {
    overTooltip = false;
    reallyHide();
  }

  tooltip.addEventListener('pointerenter', onTooltipEnter);
  tooltip.addEventListener('pointerleave', onTooltipLeave);
  view.dom.addEventListener('pointerover', onOver);
  view.dom.addEventListener('pointerout', onOut);
  view.dom.addEventListener('keydown', onKeyDown);

  return {
    destroy() {
      cancelHide();
      stopAutoUpdate?.();
      view.dom.removeEventListener('pointerover', onOver);
      view.dom.removeEventListener('pointerout', onOut);
      view.dom.removeEventListener('keydown', onKeyDown);
      tooltip.remove();
    },
  };
}

interface MarkdownLintDecorationsOptions {
  docName: string;
  /**
   * Snapshot of the full `Y.Text('source')` text — the SAME bytes the Problems
   * panel and source mode lint. When absent (provider-less harnesses), the
   * pass falls back to serializing the PM doc, which sees only normalized
   * markdown (byte-level violations invisible).
   */
  getSource?: () => string;
  /**
   * Apply a block's auto-fix edits to `Y.Text('source')` (wired to the active
   * provider). Absent in provider-less harnesses — the tooltip then shows no
   * Fix button.
   */
  applyFix?: (fixes: LintTextEdit[]) => void;
}

/**
 * TipTap extension that surfaces markdown-lint violations as block-level node
 * decorations in the WYSIWYG editor. Self-contained: fetches its own effective
 * config and recomputes off the PM doc — no React data push.
 */
export const MarkdownLintDecorations = Extension.create<MarkdownLintDecorationsOptions>({
  name: 'markdownLintDecorations',

  addOptions() {
    return { docName: '', getSource: undefined, applyFix: undefined };
  },

  addProseMirrorPlugins() {
    const { docName, getSource, applyFix } = this.options;
    // One serializer/parser for this editor's lifetime — same extension set the
    // bridge uses, so serialize→lint→parseToMdast matches the rendered content.
    const md = new MarkdownManager({ extensions: coreExtensions });

    return [
      new Plugin<DecorationSet>({
        key: markdownLintDecorationKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const next = tr.getMeta(markdownLintDecorationKey) as DecorationSet | undefined;
            if (next) return next;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return markdownLintDecorationKey.getState(state) ?? null;
          },
        },
        view(view) {
          let config: LinterConfig | null = null;
          let timer: ReturnType<typeof setTimeout> | null = null;
          let destroyed = false;
          // Bounded retry for the bridge-invariant mismatch drop below: a
          // transient PM↔Y.Text divergence usually settles within one debounce
          // window, but nothing re-schedules a pass when the drain-back lands
          // without changing the PM doc — so the drop itself retries, capped
          // so a persistent divergence can't loop the lint pass forever.
          let mismatchRetries = 0;
          // Block-offset → auto-fix edits for the current pass; the hover
          // tooltip's Fix button reads it via posAtDOM.
          let currentFixes = new Map<number, LintTextEdit[]>();

          async function recompute() {
            if (destroyed) return;
            const sourceAtStart = getSource?.() ?? null;
            const outcome = config?.enabled
              ? await computeSet(config)
              : // Clear any stale decorations when disabled / config absent.
                {
                  kind: 'ok' as const,
                  set: DecorationSet.empty,
                  fixesByOffset: new Map<number, LintTextEdit[]>(),
                };
            // The lint pass is async: bail if the plugin died or the doc moved
            // while it ran (a stale set's positions no longer fit; the edit
            // that moved the doc has already scheduled the next pass).
            if (destroyed || outcome.kind === 'stale') return;
            if (outcome.kind === 'mismatch') {
              if (mismatchRetries < 2) {
                mismatchRetries += 1;
                schedule();
              }
              return;
            }
            mismatchRetries = 0;
            currentFixes = outcome.fixesByOffset;
            const set = outcome.set;
            // Skip a no-op empty→empty dispatch. The common mount path (config
            // still loading, or no server) would otherwise fire a spurious
            // meta transaction in the editor's construct→mount window, which
            // can disturb the pre-warm mapping currency (walk-currency).
            const current = markdownLintDecorationKey.getState(view.state) ?? DecorationSet.empty;
            if (set.find().length > 0 || current.find().length > 0) {
              view.dispatch(view.state.tr.setMeta(markdownLintDecorationKey, set));
            }
            // A cross-doc project-scope click banks a pending intent and opens
            // this doc WITHOUT dispatching the live event (the event carries no
            // docName). Replay it now that this 'ok' outcome guarantees the doc
            // is hydrated and block-mapped (decorations painted just above);
            // clearing on success stops later edit-triggered passes from
            // re-scrolling. Mirrors SourceEditor's mount-time replay.
            if (config?.enabled) {
              const pending = peekPendingSourceNavigation(docName);
              if (pending?.kind === 'lint' && scrollToLintBlock(pending.detail)) {
                clearPendingSourceNavigation(docName);
              }
            }
            // Local W1 edits reach Y.Text via Observer A after the PM change
            // that scheduled this pass — if the source moved while we linted,
            // run once more so decorations settle on the current bytes (the
            // no-observer counterpart to useDocDiagnostics' Y.Text observe).
            if (sourceAtStart !== null && !destroyed && getSource?.() !== sourceAtStart) {
              schedule();
            }
          }

          type ComputeOutcome =
            | { kind: 'ok'; set: DecorationSet; fixesByOffset: Map<number, LintTextEdit[]> }
            | { kind: 'stale' }
            | { kind: 'mismatch' };

          async function computeSet(activeConfig: LinterConfig): Promise<ComputeOutcome> {
            const doc = view.state.doc;
            const source = getSource?.() ?? md.serialize(doc.toJSON());
            const diagnostics = await lintDocument(source, activeConfig, docName);
            if (!view.state.doc.eq(doc)) return { kind: 'stale' };
            const { spans } = computeSourceBlockSpans(source, md);
            // Alignment guard: body mdast children ↔ PM top-level nodes
            // (minus the sourceless trailing empty paragraph) must be 1:1 for
            // the index mapping to anchor correctly. Drop the pass (keep
            // current decorations) rather than misanchor. Not always a
            // mid-drain transient: WYSIWYG-authored shapes markdown cannot
            // spell diverge persistently (see block-spans.ts), and the drop
            // then persists with them.
            if (spans.length !== comparableChildCount(doc)) return { kind: 'mismatch' };
            const byBlock = mapDiagnosticsToBlocks(source, diagnostics, md);
            return { kind: 'ok', ...buildDecorationSet(doc, byBlock) };
          }

          function schedule() {
            if (timer) clearTimeout(timer);
            // A rejected pass (serialize can throw on exotic docs) must not be
            // swallowed: log it, and leave decorations to the next scheduled
            // pass rather than silently going stale for the view's lifetime.
            timer = setTimeout(() => {
              recompute().catch((err) => {
                console.warn('[markdown-lint] decoration pass failed', err);
              });
            }, RECOMPUTE_DEBOUNCE_MS);
          }

          let configGeneration = 0;

          async function loadConfigAndRecompute() {
            // Config fetches can resolve out of order (two rapid config-changed
            // events); only the newest load may install its result — a stale
            // resolution would pin an outdated config until the next event.
            const generation = ++configGeneration;
            const next = await fetchEffectiveLintConfig(docName);
            if (destroyed || generation !== configGeneration) return;
            config = next;
            await recompute();
          }
          // Same rejection discipline as schedule(): never swallow a failed pass.
          const startPass = () => {
            loadConfigAndRecompute().catch((err) => {
              console.warn('[markdown-lint] config load/lint pass failed', err);
            });
          };

          /**
           * Problems-panel row click (WYSIWYG counterpart of SourceEditor's
           * handler): map the diagnostic's source line to its top-level block,
           * place the caret there, and scroll it into view. Only the VISIBLE
           * editor consumes — pool-hidden editors and the WYSIWYG half of a
           * source-mode doc are `display: none` (offsetParent null) and must
           * not move selection. The event carries no docName; visibility IS the
           * doc identity.
           *
           * Scroll uses the block's native `Element.scrollIntoView`, NOT the
           * transaction's `.scrollIntoView()` — the same choice as TiptapEditor's
           * outline-click and wiki-link navigation. ProseMirror's own scroll
           * ignores the scroll container's `scroll-pt-14` toolbar inset (that's
           * CSS scroll-padding, honored only by native scrollIntoView), so a
           * transaction scroll either no-ops against OK's custom scroll
           * container or lands the block behind the toolbar. `view.focus()`
           * focuses without scrolling (prosemirror-view's focusPreventScroll),
           * so the native scroll is authoritative.
           */
          function scrollToLintBlock(detail: LintNavDetail): boolean {
            if (!view.dom.isConnected || view.dom.offsetParent === null) return false;
            // Frontmatter diagnostics have no WYSIWYG anchor (property panel
            // owns that region) — leave the banked source-mode intent alive.
            // Checked by producing plugin, not by line, for the same reason the
            // decoration mapping does: on a doc with no frontmatter the
            // violation's line points into the body.
            if (detail.source === 'frontmatter') return false;
            const source = getSource?.() ?? md.serialize(view.state.doc.toJSON());
            const { spans, fmLineCount } = computeSourceBlockSpans(source, md);
            if (spans.length !== comparableChildCount(view.state.doc)) return false;
            if (fmLineCount > 0 && detail.line <= fmLineCount) return false;
            const index = blockIndexForLine(spans, detail.line);
            if (index === null) return false;
            let blockOffset = -1;
            view.state.doc.forEach((_node, offset, i) => {
              if (i === index) blockOffset = offset;
            });
            if (blockOffset < 0) return false;
            // Caret and viewport move together or not at all. A position-
            // preserving mode-switch landing is superseded here — the row the
            // user clicked outranks the position they were keeping — while a
            // landing that is itself an explicit navigation keeps the scroller
            // and this click stands down whole, leaving the banked source-mode
            // intent alive for the caller to replay.
            return runScrollNavigation(docName, () => {
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.near(view.state.doc.resolve(blockOffset + 1)),
                ),
              );
              view.focus();
              const blockDom = view.nodeDOM(blockOffset);
              if (blockDom instanceof HTMLElement) {
                blockDom.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            });
          }

          // Live Problems-row click for the OPEN doc. The cross-doc project
          // path banks its intent instead (replayed in recompute on mount).
          function onLintNav(event: Event) {
            const detail = (event as CustomEvent<LintNavDetail>).detail;
            if (!detail || detail.docName !== docName || destroyed) return;
            // Consumed here — a later flip to source mode must not replay it.
            if (scrollToLintBlock(detail)) clearPendingSourceNavigation(docName);
          }

          startPass();
          const unsubscribe = subscribeToLintConfigChanged(startPass);
          // Resolve a decorated block's DOM element to its auto-fix edits via the
          // current pass's offset map (posAtDOM → top-level block start offset).
          const getFixes = (block: HTMLElement): LintTextEdit[] => {
            if (block.getAttribute(LINT_FIXABLE_ATTR) !== '1' || currentFixes.size === 0) return [];
            let pos: number;
            try {
              pos = view.posAtDOM(block, 0);
            } catch (err) {
              // posAtDOM throws on detached/partially-recycled DOM. Returning []
              // suppresses the Fix button (the correct fallback), but log so a
              // systematic failure (e.g. after a ProseMirror upgrade) leaves a
              // signal instead of a silently dark Fix surface — matching the
              // sibling recompute/startPass catches.
              console.warn(
                '[markdown-lint] posAtDOM failed on lint block; Fix button suppressed',
                err,
              );
              return [];
            }
            const clamped = Math.min(Math.max(pos, 0), view.state.doc.content.size);
            const resolved = view.state.doc.resolve(clamped);
            const offset = resolved.depth >= 1 ? resolved.before(1) : 0;
            return currentFixes.get(offset) ?? [];
          };
          const tooltip = createLintTooltip(view, { getFixes, applyFix });
          window.addEventListener(LINT_NAV_EVENT, onLintNav);
          // Re-lint after a source-only auto-fix (which leaves the PM doc — and
          // thus the update() hook below — untouched) so the stale squiggle clears.
          const onSourceFixed = () => {
            if (!destroyed) schedule();
          };
          window.addEventListener(LINT_SOURCE_FIXED_EVENT, onSourceFixed);

          return {
            update(updatedView, prevState) {
              // Identity, not `.eq`: a server-side full-body replace whose body
              // bytes are unchanged (e.g. an agent write that only edits
              // frontmatter) can reach this view as a content-EQUAL rebuild —
              // new top-level nodes carrying the same text. Its mapping still
              // destroys the node decorations on the replaced ranges, but
              // `.eq` compares content and reads the transaction as "no doc
              // change", so nothing reschedules and the decorations stay gone
              // until an unrelated edit. Doc identity changes exactly when a
              // transaction carried real steps (meta-only dispatches — ours
              // included — keep the same doc object), so this predicate is
              // step-sensitive without self-looping on the decoration dispatch.
              if (updatedView.state.doc !== prevState.doc) schedule();
            },
            destroy() {
              destroyed = true;
              if (timer) clearTimeout(timer);
              unsubscribe();
              tooltip.destroy();
              window.removeEventListener(LINT_NAV_EVENT, onLintNav);
              window.removeEventListener(LINT_SOURCE_FIXED_EVENT, onSourceFixed);
            },
          };
        },
      }),
    ];
  },
});
