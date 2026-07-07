/**
 * Code mark override for source-text fidelity.
 *
 * Extends @tiptap/extension-code (preserving setCode/toggleCode/unsetCode
 * commands, Cmd+E shortcut, and input rules) and removes `excludes: '_'`
 * so the Code mark can coexist with other inline marks (emphasis, strong).
 *
 * Why:
 *   The upstream Code mark declares `excludes: '_'` which prevents ANY other
 *   mark from sharing a span with code. CommonMark explicitly allows
 *   emphasis/strong to wrap inline-code spans (e.g. `*a \`*\`*`). With the
 *   exclusion in place, mdast → PM drops the emphasis mark from the inlineCode
 *   span; PM → mdast then can't recover the original coverage and emits
 *   siblings instead of a wrapped structure, breaking idempotence.
 *
 * Schema widening per precedent #9 (add-only forever — widening is allowed,
 * narrowing is not). Editor render: italic/bold-within-inline-code now
 * possible. Visual rendering follows browser default `<em><code>` /
 * `<strong><code>` styling — no NodeView changes required for correctness.
 */

import Code from '@tiptap/extension-code';

export const CodeMarkFidelity = Code.extend({
  // COUPLED: patches/@handlewithcare%2Fremark-prosemirror@0.1.5.patch
  // The `hydrateMarks` replacement in that patch (outside-in greedy nesting)
  // assumes Code can coexist with emphasis/strong on the same span. If this
  // widening is reverted — e.g. during a TipTap upstream upgrade — the patch
  // silently reverts to producing sibling emission instead of nested, and
  // CommonMark corpus idempotence fails for `*a \`*\`*`-class inputs. Do NOT
  // narrow this field (precedent #9 + CLAUDE.md WARN rule).
  excludes: '',

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceFenceChar: { default: '`' },
      sourceFenceLength: { default: 1 },
      // The author typed the CommonMark §6.1 padded form (`` ` y ` ``)
      // even though padding wasn't structurally required; replayed on
      // serialize so the pad spaces round-trip byte-equal.
      sourcePadded: { default: false, rendered: false },
    };
  },
});
