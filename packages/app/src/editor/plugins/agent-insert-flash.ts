/**
 * Agent-insert flash — position-accurate highlight of the ranges an agent
 * write just changed, the "the agent is editing this document" moment for
 * follow mode.
 *
 * The ambient block flash (`data-agent-flash-state`, first/last-3-blocks
 * CSS) stays as the coarse signal; this plugin decorates the ACTUAL changed
 * ranges of the remote transaction with `.ok-agent-insert-flash`, whose CSS
 * animation is a short highlight sweep. Decorations are timestamped and
 * swept after `AGENT_INSERT_FLASH_MS`, so overlapping writes each get their
 * own full animation without an early global clear.
 *
 * Pure ProseMirror — the TipTap wiring (which transactions count as agent
 * writes, the follow-mode scroll) lives in `TiptapEditor.tsx`.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const AGENT_INSERT_FLASH_MS = 1_400;

export const agentInsertFlashKey = new PluginKey<DecorationSet>('okAgentInsertFlash');

interface AgentInsertFlashMeta {
  /** Range (final-doc coordinates) to decorate, stamped with `now`. */
  add?: { from: number; to: number };
  /** Wall-clock of the add / sweep — injectable for tests. */
  now: number;
  /** Drop decorations older than `AGENT_INSERT_FLASH_MS` as of `now`. */
  sweep?: boolean;
}

interface FlashSpec {
  addedAt: number;
}

/**
 * The single region that actually changed between two document states, in
 * new-document coordinates, or null when they are identical.
 *
 * Uses ProseMirror's structural `findDiffStart` / `findDiffEnd` rather than
 * the transaction's step ranges. This is what makes the flash precise for
 * agent writes: an agent `replace` rewrites the whole raw body, so the
 * resulting transaction reports a single whole-document step (`0..end`) even
 * when only a tail section was appended — the step range would flash and
 * scroll the entire doc. The prefix/suffix diff collapses that to just the
 * bytes that differ (the appended section, the edited paragraph), so follow
 * mode scrolls to where the agent is actually writing.
 */
export function computeChangedRange(
  before: PMNode,
  after: PMNode,
): { from: number; to: number } | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null || start === undefined) return null;
  const ends = before.content.findDiffEnd(after.content);
  // `ends.b` is the last-differing boundary in the AFTER doc. Clamp so a
  // suffix shorter than the prefix (heavy deletion) still yields from <= to.
  const afterSize = after.content.size;
  const from = Math.max(0, Math.min(start, afterSize));
  const to = Math.max(from, Math.min(ends?.b ?? afterSize, afterSize));
  if (to <= from) return null;
  return { from, to };
}

/**
 * Freshness window for the activation replay (follow mode). When an editor
 * becomes the active doc — or first mounts and syncs — AFTER an agent write
 * already landed, there is no before→after transaction to drive the live
 * flash. If the accompanying `agent-flash` entry is younger than this, we
 * replay the flash + scroll from the entry's `changedBlocks` range. Wider than
 * `AGENT_INSERT_FLASH_MS` to absorb follow-navigation lag, but short enough
 * that clicking into a doc the agent touched a while ago doesn't re-flash it.
 */
export const AGENT_INSERT_FLASH_ACTIVATION_MS = 6_000;

/**
 * Map a top-level block-index range `[fromBlock, toBlock)` to a ProseMirror
 * position range in `doc`, or null when empty / out of bounds.
 *
 * The activation-replay counterpart to `computeChangedRange`: the write has
 * already applied, so there is no transaction to diff — the server stamped the
 * changed block indices instead. They address PM top-level nodes directly
 * (y-prosemirror mirrors the XmlFragment's children onto the PM doc), so the
 * PM range is the span from the boundary before the first changed block to the
 * boundary after the last.
 */
export function blockRangeToPositions(
  doc: PMNode,
  fromBlock: number,
  toBlock: number,
): { from: number; to: number } | null {
  const childCount = doc.childCount;
  const first = Math.max(0, Math.min(fromBlock, childCount));
  const last = Math.max(first, Math.min(toBlock, childCount));
  if (last <= first) return null;
  let pos = 0;
  for (let i = 0; i < first; i++) pos += doc.child(i).nodeSize;
  const from = pos;
  for (let i = first; i < last; i++) pos += doc.child(i).nodeSize;
  const to = pos;
  const size = doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, size));
  const clampedTo = Math.max(clampedFrom, Math.min(to, size));
  if (clampedTo <= clampedFrom) return null;
  return { from: clampedFrom, to: clampedTo };
}

export function createAgentInsertFlashPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: agentInsertFlashKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, decorations) {
        let next = decorations.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(agentInsertFlashKey) as AgentInsertFlashMeta | undefined;
        if (meta === undefined) return next;
        if (meta.sweep === true) {
          const expired = next
            .find()
            .filter(
              (deco) => meta.now - ((deco.spec as FlashSpec).addedAt ?? 0) >= AGENT_INSERT_FLASH_MS,
            );
          if (expired.length > 0) next = next.remove(expired);
        }
        if (meta.add !== undefined && meta.add.to > meta.add.from) {
          const spec: FlashSpec = { addedAt: meta.now };
          next = next.add(tr.doc, [
            Decoration.inline(meta.add.from, meta.add.to, { class: 'ok-agent-insert-flash' }, spec),
          ]);
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return agentInsertFlashKey.getState(state);
      },
    },
  });
}
