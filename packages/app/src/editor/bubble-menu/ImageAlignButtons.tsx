/**
 * ImageAlignButtons — bubble-menu controls for setting `align` on the
 * selected alignable jsxComponent (today: `img` / `CommonMarkImage` /
 * `Embed` / `video`). The filename predates Embed and video joining
 * the alignable set; conceptually it now covers any descriptor whose
 * `align` prop matches the htmlImgProps shape — see
 * `editor/utils/alignable-descriptors.ts` for the canonical list.
 *
 * The `htmlImgProps` / `embedProps` descriptors (`packages/core/src/
 * registry/built-ins.ts`) carry an `align: enum('center' | 'left' |
 * 'right')` prop with a default of `'center'` and `omitOnDefault: true`.
 * These three buttons mutate that prop via `setNodeMarkup` on the active
 * jsxComponent — `JsxComponentView` then mirrors the new value into
 * `data-align` on the wrapper, and CSS (`globals.css`
 * `.jsx-component-wrapper[data-component-type="img"][data-align]` +
 * matching `commonmarkimage` / `embed` selectors) applies the
 * corresponding `text-align` rule (the inline child takes its horizontal
 * placement from the wrapper's text-align — keeps the wrapper at column
 * width so the chrome bar's right edge doesn't overlap small content's
 * click region).
 *
 * Sister to `InlineFormatButtons` (Bold / Italic / etc.) — same
 * lucide-react icon style, same shadcn `Button` size + variant, same
 * active-state mechanism (`className` conditional, not variant swap),
 * same `onMouseDown` event semantics, same `Tooltip` `side`/`sideOffset`
 * positioning. Only ever rendered by `BubbleMenuBar` when an image
 * jsxComponent is NodeSelected (the parent's `useEditorState` guard).
 *
 * The chrome bar in `JsxComponentView` is the primary alignment surface
 * (hover-revealed, doesn't fight with `react-medium-image-zoom`'s
 * lightbox). This bubble-menu path stays as a secondary surface
 * reachable when the image is selected via keyboard navigation —
 * NodeSelection on a leaf atom has empty `textBetween`, which the
 * default bubble-menu `shouldShow` would reject; `BubbleMenuBar`'s
 * extended predicate flips on for image NodeSelection so the controls
 * are reachable.
 */

import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ALIGNABLE_DESCRIPTOR_NAMES } from '../utils/alignable-descriptors.ts';
import { runWithAlignAnimation } from '../utils/animate-align-change.ts';

type Align = 'center' | 'left' | 'right';

const ALIGN_OPTIONS: ReadonlyArray<{
  value: Align;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'left', label: 'Align left', icon: AlignLeft },
  { value: 'center', label: 'Align center', icon: AlignCenter },
  { value: 'right', label: 'Align right', icon: AlignRight },
];

/**
 * Read the active alignable jsxComponent's current `props.align`. The
 * `img` canonical, the `CommonMarkImage` compat, the `Embed` canonical,
 * and the `video` canonical are all supported — `img`, `Embed`, and
 * `video` declare `align` directly; `CommonMarkImage` upgrades to `img`
 * on first non-default alignment (its prop set has no `align`, so we
 * have to swap descriptors to persist the value through serialize).
 * Returns `null` when selection isn't on an alignable node and the
 * parent should not render this.
 *
 * Anything outside the canonical `'left' | 'center' | 'right'` enum is
 * clamped to `'center'` so the active-state visual stays consistent
 * with what the wrapper's CSS actually renders for an unrecognized
 * value.
 */
function readActiveImageAlign(editor: Editor): Align | null {
  const sel = editor.state.selection;
  // NodeSelection on a jsxComponent — that's how PM exposes the
  // selected media block.
  const node = (sel as { node?: { type: { name: string }; attrs: Record<string, unknown> } }).node;
  if (!node) return null;
  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName;
  if (!ALIGNABLE_DESCRIPTOR_NAMES.has(String(componentName))) {
    return null;
  }
  const props = (node.attrs.props ?? {}) as Record<string, unknown>;
  const raw = props.align;
  if (raw === 'left' || raw === 'right' || raw === 'center') return raw;
  return 'center';
}

interface ImageAlignButtonsProps {
  editor: Editor;
}

export function ImageAlignButtons({ editor }: ImageAlignButtonsProps) {
  const active = useEditorState({
    editor,
    selector: (ctx) => readActiveImageAlign(ctx.editor),
  });

  // Parent guard double-checks before mounting; this guard is defense-in-
  // depth so a stale render doesn't blow up the menu when selection moves.
  if (active === null) return null;

  // No wrapper-level role / label — `aria-label` on a generic `<div>`
  // without a `role` is invalid ARIA, and the WAI-ARIA shape that fits
  // (`role="group"`) maps to `<fieldset>` per biome's useSemanticElements
  // rule, but `<fieldset>` carries form-control semantics + native
  // styling we don't want for a floating-toolbar button cluster. The
  // per-button `aria-label` ("Align left/center/right") and `aria-pressed`
  // already provide granular semantics; the wrapper's job is layout only.
  return (
    <div className="flex items-center gap-0.5">
      {ALIGN_OPTIONS.map(({ value, label, icon: Icon }) => {
        const isActive = active === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                aria-pressed={isActive}
                className={isActive ? 'bg-accent text-primary' : 'text-accent-foreground'}
                onMouseDown={(e) => {
                  // Preserve the editor's selection — `Button`'s default
                  // mousedown would steal focus from the editor view.
                  // Mirrors `InlineFormatButtons`.
                  e.preventDefault();
                  // Re-read the live selection at click time. The
                  // useEditorState selector above settles on a render-
                  // time snapshot; if the user's selection has moved
                  // (keyboard nav between the render and the click) we
                  // bail rather than write `align` to the wrong node.
                  const sel = editor.state.selection;
                  const liveNode = (
                    sel as {
                      node?: { type: { name: string }; attrs: Record<string, unknown> };
                    }
                  ).node;
                  if (!liveNode || liveNode.type.name !== 'jsxComponent') return;
                  const componentName = String(liveNode.attrs.componentName ?? '');
                  if (!ALIGNABLE_DESCRIPTOR_NAMES.has(componentName)) {
                    return;
                  }
                  // Kind-discriminator drift guard — mirrors the chrome-bar
                  // handler in `JsxComponentView.tsx` and the PropPanel
                  // onChange dispatch. `img` / `CommonMarkImage` are
                  // inherently element-kind descriptors, but the explicit
                  // check defends against a future schema change that adds
                  // an expression-kind alias.
                  if (liveNode.attrs.kind !== 'element') return;
                  const isCommonMark = componentName === 'CommonMarkImage';
                  const pos = (sel as { from: number }).from;
                  const nextProps = {
                    ...((liveNode.attrs.props ?? {}) as Record<string, unknown>),
                    align: value,
                  };
                  // `sourceDirty: true` is mandatory: parsed images
                  // carry a verbatim `sourceRaw` which the serializer
                  // emits unchanged on the pristine path
                  // (`markdown/index.ts:effectiveDirty` check). Without
                  // it the align change is silently dropped on save.
                  // Mirrors the established PropPanel write pattern in
                  // `JsxComponentView.tsx`.
                  const nextAttrs = isCommonMark
                    ? {
                        ...liveNode.attrs,
                        componentName: 'img',
                        props: nextProps,
                        sourceDirty: true,
                      }
                    : { ...liveNode.attrs, props: nextProps, sourceDirty: true };
                  // `setNodeMarkup` demotes the active NodeSelection to
                  // a TextSelection at the same offset — the bubble
                  // menu would hide immediately on click without us
                  // re-applying the NodeSelection on the same
                  // transaction. Mirrors the pattern in
                  // `MathInlineView.tsx`.
                  const tr = editor.state.tr.setNodeMarkup(pos, null, nextAttrs);
                  tr.setSelection(NodeSelection.create(tr.doc, pos));
                  // FLIP-animate the inline-block child of the wrapper
                  // through the position shift. `text-align` isn't an
                  // animatable property — without this, the image
                  // teleports from one side to the other. `nodeDOM(pos)`
                  // resolves to the NodeViewWrapper carrying the
                  // alignment CSS; the helper is a no-op when null.
                  const wrapperEl = editor.view.nodeDOM(pos) as HTMLElement | null;
                  runWithAlignAnimation(wrapperEl, () => {
                    editor.view.dispatch(tr);
                  });
                }}
              >
                <Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              {label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Pure helper for `BubbleMenuBar`'s `shouldShow` extension — returns true
 * when selection is on an alignable jsxComponent (`img` / `CommonMarkImage`
 * / `Embed` / `video`). Exported so the parent can gate the bubble menu (which
 * otherwise hides on empty-text selections, like a NodeSelection over a
 * leaf atom). Name retained for back-compat with `BubbleMenuBar`'s
 * import; the predicate now matches every descriptor `ImageAlignButtons`
 * services.
 */
export function isImageNodeSelected(editor: Editor): boolean {
  return readActiveImageAlign(editor) !== null;
}
