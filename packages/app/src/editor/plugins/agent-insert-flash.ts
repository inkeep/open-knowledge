import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const AGENT_INSERT_FLASH_MS = 1_400;

export const agentInsertFlashKey = new PluginKey<DecorationSet>('okAgentInsertFlash');

interface AgentInsertFlashMeta {
  add?: { from: number; to: number };
  now: number;
  sweep?: boolean;
}

interface FlashSpec {
  addedAt: number;
}

export function computeChangedRange(
  before: PMNode,
  after: PMNode,
): { from: number; to: number } | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null || start === undefined) return null;
  const ends = before.content.findDiffEnd(after.content);
  const afterSize = after.content.size;
  const from = Math.max(0, Math.min(start, afterSize));
  const to = Math.max(from, Math.min(ends?.b ?? afterSize, afterSize));
  if (to <= from) return null;
  return { from, to };
}

export const AGENT_INSERT_FLASH_ACTIVATION_MS = 6_000;

export { blockRangeToPositions } from '../block-spans';

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
