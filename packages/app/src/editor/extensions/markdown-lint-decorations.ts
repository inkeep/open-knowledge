import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import {
  sharedExtensions as coreExtensions,
  isFrontmatterScoped,
  type LintDiagnostic,
  type LinterConfig,
  type LintTextEdit,
  lintDocument,
  MarkdownManager,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { type Editor, Extension } from '@tiptap/core';
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
import {
  deriveEditorClipOptions,
  deriveEditorShiftOptions,
  deriveEditorSizeOptions,
} from '@/editor/utils/editor-visible-region';
import { cn } from '@/lib/utils';
import { blockIndexForLine, comparableChildCount, computeSourceBlockSpans } from '../block-spans';
import { fetchEffectiveLintConfig, subscribeToLintConfigChanged } from '../lint-config-client';
import { runScrollNavigation } from '../scroll-restore-coordination';

const LINT_CALLOUT_GAP_PX = 6;

const LINT_CALLOUT_MAX_WIDTH = '22rem';

const markdownLintDecorationKey = new PluginKey<DecorationSet>('markdownLintDecorations');

const OK_LINT_BLOCK_CLASS = 'ok-lint-block';
const OK_LINT_BLOCK_ERROR_CLASS = 'ok-lint-block-error';
const OK_LINT_BLOCK_ATOM_CLASS = 'ok-lint-block-atom';

const RECOMPUTE_DEBOUNCE_MS = 400;

function isFrontmatterAnchorless(diagnostic: LintDiagnostic): boolean {
  return isFrontmatterScoped(diagnostic);
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

const LINT_TOOLTIP_ATTR = 'data-ok-lint';
const LINT_FIXABLE_ATTR = 'data-ok-lint-fixable';

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
    const tooltip = diagnostics.map((d) => `${d.source}/${d.code}: ${d.message}`).join('\n');
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

function createLintTooltip(
  view: EditorView,
  opts: {
    getFixes: (block: HTMLElement) => LintTextEdit[];
    applyFix?: (fixes: LintTextEdit[]) => void;
    editor: Editor;
  },
): { destroy: () => void } {
  const tooltip = document.createElement('div');
  tooltip.className = 'ok-lint-tooltip';
  tooltip.hidden = true;
  const message = document.createElement('div');
  message.className = 'ok-lint-tooltip-message';
  tooltip.appendChild(message);
  const fixButton = document.createElement('button');
  fixButton.type = 'button';
  fixButton.className = cn(
    'ok-lint-tooltip-fix',
    buttonVariants({ variant: 'default', size: 'xs' }),
    'mt-1 self-start',
  );
  fixButton.hidden = true;
  tooltip.appendChild(fixButton);
  tooltip.style.position = 'fixed';
  tooltip.style.top = '0';
  tooltip.style.left = '0';
  document.body.appendChild(tooltip);

  let current: HTMLElement | null = null;
  let overTooltip = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let stopAutoUpdate: (() => void) | null = null;
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

  function scheduleHide() {
    if (overTooltip) return;
    cancelHide();
    hideTimer = setTimeout(reallyHide, 140);
  }

  const clipOptions = deriveEditorClipOptions(opts.editor);
  const shiftOptions = deriveEditorShiftOptions(opts.editor);
  const sizeOptions = deriveEditorSizeOptions(opts.editor, {
    authorMaxWidth: LINT_CALLOUT_MAX_WIDTH,
  });

  function position() {
    computePosition(virtualEl, tooltip, {
      placement: 'top-start',
      middleware: [
        offset(LINT_CALLOUT_GAP_PX),
        flip(clipOptions),
        shift(shiftOptions),
        size(sizeOptions),
      ],
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
    stopAutoUpdate = autoUpdate(virtualEl, tooltip, position);
  }

  function onOver(event: Event) {
    const pe = event as PointerEvent;
    const target = event.target as HTMLElement | null;
    const block = target?.closest<HTMLElement>(`.${OK_LINT_BLOCK_CLASS}`) ?? null;
    if (block) {
      if (block !== current) {
        anchorX = pe.clientX;
        const found = view.posAtCoords({ left: pe.clientX, top: pe.clientY });
        const measured = found ? view.coordsAtPos(found.pos) : null;
        const line =
          measured && measured.bottom > measured.top ? measured : block.getBoundingClientRect();
        anchorTop = line.top;
        anchorBottom = line.bottom;
        show(block);
      } else {
        cancelHide();
      }
    } else if (current) {
      scheduleHide();
    }
  }

  function onOut(event: Event) {
    const related = (event as PointerEvent).relatedTarget as HTMLElement | null;
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
  getSource?: () => string;
  applyFix?: (fixes: LintTextEdit[]) => void;
}

export const MarkdownLintDecorations = Extension.create<MarkdownLintDecorationsOptions>({
  name: 'markdownLintDecorations',

  addOptions() {
    return { docName: '', getSource: undefined, applyFix: undefined };
  },

  addProseMirrorPlugins() {
    const { docName, getSource, applyFix } = this.options;
    const { editor } = this;
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
          let mismatchRetries = 0;
          let currentFixes = new Map<number, LintTextEdit[]>();

          async function recompute() {
            if (destroyed) return;
            const sourceAtStart = getSource?.() ?? null;
            const outcome = config?.enabled
              ? await computeSet(config)
              : {
                  kind: 'ok' as const,
                  set: DecorationSet.empty,
                  fixesByOffset: new Map<number, LintTextEdit[]>(),
                };
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
            const current = markdownLintDecorationKey.getState(view.state) ?? DecorationSet.empty;
            if (set.find().length > 0 || current.find().length > 0) {
              view.dispatch(view.state.tr.setMeta(markdownLintDecorationKey, set));
            }
            if (config?.enabled) {
              const pending = peekPendingSourceNavigation(docName);
              if (pending?.kind === 'lint' && scrollToLintBlock(pending.detail)) {
                clearPendingSourceNavigation(docName);
              }
            }
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
            if (spans.length !== comparableChildCount(doc)) return { kind: 'mismatch' };
            const byBlock = mapDiagnosticsToBlocks(source, diagnostics, md);
            return { kind: 'ok', ...buildDecorationSet(doc, byBlock) };
          }

          function schedule() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              recompute().catch((err) => {
                console.warn('[markdown-lint] decoration pass failed', err);
              });
            }, RECOMPUTE_DEBOUNCE_MS);
          }

          let configGeneration = 0;

          async function loadConfigAndRecompute() {
            const generation = ++configGeneration;
            const next = await fetchEffectiveLintConfig(docName);
            if (destroyed || generation !== configGeneration) return;
            config = next;
            await recompute();
          }
          const startPass = () => {
            loadConfigAndRecompute().catch((err) => {
              console.warn('[markdown-lint] config load/lint pass failed', err);
            });
          };

          function scrollToLintBlock(detail: LintNavDetail): boolean {
            if (!view.dom.isConnected || view.dom.offsetParent === null) return false;
            if (isFrontmatterScoped(detail)) return false;
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
            return runScrollNavigation(docName, 'problems-row', () => {
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

          function onLintNav(event: Event) {
            const detail = (event as CustomEvent<LintNavDetail>).detail;
            if (!detail || detail.docName !== docName || destroyed) return;
            if (scrollToLintBlock(detail)) clearPendingSourceNavigation(docName);
          }

          startPass();
          const unsubscribe = subscribeToLintConfigChanged(startPass);
          const getFixes = (block: HTMLElement): LintTextEdit[] => {
            if (block.getAttribute(LINT_FIXABLE_ATTR) !== '1' || currentFixes.size === 0) return [];
            let pos: number;
            try {
              pos = view.posAtDOM(block, 0);
            } catch (err) {
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
          const tooltip = createLintTooltip(view, { getFixes, applyFix, editor });
          window.addEventListener(LINT_NAV_EVENT, onLintNav);
          const onSourceFixed = () => {
            if (!destroyed) schedule();
          };
          window.addEventListener(LINT_SOURCE_FIXED_EVENT, onSourceFixed);

          return {
            update(updatedView, prevState) {
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
