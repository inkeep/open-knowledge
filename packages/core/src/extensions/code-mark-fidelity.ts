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
  excludes: '',

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceFenceChar: { default: '`' },
      sourceFenceLength: { default: 1 },
      sourcePadded: { default: false, rendered: false },
    };
  },
});
