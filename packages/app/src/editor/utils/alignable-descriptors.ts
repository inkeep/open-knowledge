/**
 * Canonical set of jsxComponent descriptor names that participate in
 * the `align`-based positioning pipeline — `text-align` on the wrapper,
 * FLIP-animated transitions, chrome-bar alignment trio, and the
 * bubble-menu keyboard-reachability predicate (`isImageNodeSelected`
 * in `ImageAlignButtons.tsx`).
 *
 * Lives in a shared utility — not on JsxComponentView — so every
 * surface that gates on "is this an alignable descriptor?" reads from
 * the same Set. Adding a fifth alignable descriptor lands here and
 * propagates automatically to:
 *   - `JsxComponentView.tsx` (data-align default clamp, chrome-bar
 *     render condition, chrome-bar click handler live-reread)
 *   - `ImageAlignButtons.tsx` (`readActiveImageAlign` predicate +
 *     bubble-menu onMouseDown live-reread)
 *
 * The descriptor's own `align` PropDef in
 * `packages/core/src/registry/built-ins.ts` is a separate concern —
 * adding the prop is what makes the chrome-bar / PropPanel render the
 * dropdown; adding the descriptor name here is what makes the gate
 * predicates recognize it.
 */
export const ALIGNABLE_DESCRIPTOR_NAMES = new Set<string>([
  'img',
  'CommonMarkImage',
  'Embed',
  'video',
]);
