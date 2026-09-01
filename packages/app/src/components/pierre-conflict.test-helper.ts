/**
 * Shared test infrastructure for Pierre conflict-view tests.
 *
 * A leftover `<diffs-container>` from a prior test in the same file silently
 * hijacks `document.querySelector` and produces phantom failures — always call
 * `inst.cleanUp()` and remove the host element in afterEach.
 */

/**
 * A diff3-dialect conflict fixture containing a single conflict with a
 * start marker, current section, base marker, separator, incoming section
 * and end marker. Used to prove the diff3 base view renders (Q15).
 *
 * The fixture includes surrounding prose so context lines appear and the
 * hunk is not at the very start of the file, which exercises the parser
 * on a realistic input.
 */
export const DIFF3_FIXTURE = `# Conflict Test Document

Some preamble text before the conflict region.

<<<<<<< ours
The knowledge base stores every note as plain markdown on the filesystem, so you own your files outright and they remain readable without any software.
||||||| original
The knowledge base stores files as plain text on the filesystem.
=======
The knowledge base stores every document as plain markdown, ensuring long-term durability and readability without proprietary software.
>>>>>>> theirs

Some trailing text after the conflict region.
`;

/**
 * Returns the open shadow root of the first `<diffs-container>` that Pierre
 * rendered into `container`. Pierre mounts via an autonomous custom element
 * with an open shadow root; `container.shadowRoot` is not the right target —
 * the host element is a child.
 *
 * Throws with a descriptive message rather than returning null so callers
 * get a clear failure instead of a silent null-dereference.
 */
export function pierreShadow(container: HTMLElement): ShadowRoot {
  const el = container.querySelector('diffs-container');
  if (!el) {
    throw new Error('pierreShadow: no <diffs-container> found in container');
  }
  if (!el.shadowRoot) {
    throw new Error('pierreShadow: <diffs-container> has no open shadow root');
  }
  return el.shadowRoot;
}
