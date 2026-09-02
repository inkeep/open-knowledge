/**
 * Shared module-level `MarkdownManager` singleton for client-side parse /
 * serialize. Multiple NodeViews and utility paths need this — every fresh
 * allocation builds a parse + serialize processor, so
 * allocating one per-call was measurably expensive on component-heavy
 * docs. Per precedent #15, the underlying remark plugins are idempotent
 * under re-entry, so one manager safely serves every call.
 *
 * Consumers today:
 *   - `utils/reconstruct-source.ts` — serializes a jsxComponent node back
 *     to MDX source for the wildcard / render-error auto-convert path.
 *   - `extensions/RawMdxFallbackCMView.tsx` — parses the nested CM source
 *     on blur to upgrade `rawMdxFallback` → `jsxComponent` when the user
 *     fixes broken MDX.
 */
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';

let manager: MarkdownManager | null = null;

export function getSharedMarkdownManager(): MarkdownManager {
  manager ||= new MarkdownManager({ extensions: sharedExtensions });
  return manager;
}

/**
 * The projection binding's own manager, with the structural-freshness derive ON.
 *
 * A `jsxComponent` serializes from the `sourceRaw` slice captured at parse time,
 * NOT from its children, so a WYSIWYG edit inside a component emits the stale
 * capture and the edit is silently discarded — it stays on screen and never
 * reaches `Y.Text`, so it disappears at the next mode switch or reload. The
 * freshness derive is what notices the children have diverged and re-derives
 * instead of emitting the stale slice.
 *
 * Under the bridge this was covered: the SERVER serialized the fragment, and
 * the server's `mdManager` has always had the flag on. The projection moves
 * that serialize onto the client, where no manager had it — so the coverage was
 * lost with the move rather than never having existed.
 *
 * Kept separate from `buildClipboardState`'s manager rather than flipping the
 * flag there, because that one also backs the clipboard's copy/cut/paste/drop
 * serializers, and re-deriving is not obviously wanted for a copied slice. This
 * is the one place the projection writes bytes.
 *
 * Note the derive re-indents a component's body to its canonical form rather
 * than reproducing the captured bytes, which is a byte-level change for a
 * component whose children were edited. That is the same output the server
 * already produced for the same edit, so it matches what is on disk today.
 */
let projectionManager: MarkdownManager | null = null;

export function getProjectionMarkdownManager(): MarkdownManager {
  projectionManager ||= new MarkdownManager({
    extensions: sharedExtensions,
    deriveStructuralFreshness: true,
  });
  return projectionManager;
}
