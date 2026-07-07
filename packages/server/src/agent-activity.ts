/**
 * Agent Activity Panel — server-side data synthesis.
 *
 * Reads per-session `Y.UndoManager.undoStack` to produce per-burst stats and
 * unified-diff text. No git, no disk — pure in-memory CRDT introspection.
 *
 * Data source rationale:
 *   - Shadow repo: per-writer commits in the same L2 drain share a tree SHA;
 *     tree-level diff cannot isolate one writer's contribution.
 *   - `Y.Map('agent-effects')`: ephemeral 50-entry ring shared across agents;
 *     lacks deleted-text content.
 *   - `Y.UndoManager.undoStack`: origin-tagged, per-session, tombstone-safe.
 *     `Y.UndoManager.keepItem(item, true)` at capture guarantees content
 *     readable while the StackItem is on the stack.
 *
 * API discipline: we use yjs's top-level public exports (`iterateDeletedStructs`,
 * `Item`, `ContentString`) for classification rather than reaching into
 * `ytext.__proto__` internals. Document-order traversal uses `AbstractType._start`
 * + `Item.right` — both are publicly typed in `node_modules/yjs/dist/src/**`
 * and are the documented way to walk a Y.Text's Item chain.
 */
import { AGENT_ICON_COLORS, colorFromSeed, iconFromClientName } from '@inkeep/open-knowledge-core';
import { createPatch } from 'diff';
import type * as Y from 'yjs';
import { ContentString, Item, iterateDeletedStructs } from 'yjs';
import type { AgentSessionManager } from './agent-sessions.ts';

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

// Neither `StackItem` nor `DeleteSet` appear in yjs's top-level type exports,
// but both are internal classes whose shapes are stable across yjs 13.x. We
// mirror the documented-public shape here; `iterateDeletedStructs` below is
// the public entry for iterating the Items referenced by a DeleteSet.
interface YjsDeleteSetShape {
  clients: Map<number, Array<{ clock: number; len: number }>>;
}
interface YjsStackItemShape {
  insertions: YjsDeleteSetShape;
  deletions: YjsDeleteSetShape;
  meta: Map<unknown, unknown>;
}

/**
 * Collect the set of CRDT Items whose IDs fall within a given DeleteSet.
 * Uses yjs's top-level `iterateDeletedStructs`. `Struct` arg is typed
 * `GC | Item` by yjs; we filter by `instanceof Item`.
 */
function collectItemsInDeleteSet(
  tr: Y.Transaction,
  ds: YjsDeleteSetShape,
  intoInstances: Set<Item>,
): void {
  // `iterateDeletedStructs` signature accepts yjs's internal `DeleteSet`;
  // our structural mirror has the same fields the implementation reads.
  iterateDeletedStructs(
    tr,
    ds as unknown as Parameters<typeof iterateDeletedStructs>[1],
    (struct) => {
      if (struct instanceof Item) {
        intoInstances.add(struct);
      }
    },
  );
}

// Walk the Y.Text Item chain via its publicly typed `_start` entry + `right`
// sibling pointers. `AbstractType._start` is declared in
// `node_modules/yjs/dist/src/types/AbstractType.d.ts` — documented public
// surface despite the underscore prefix (convention-only; TypeScript-visible).
function* walkYTextItems(ytext: Y.Text): IterableIterator<Item> {
  let cursor = (ytext as unknown as { _start: Item | null })._start;
  while (cursor !== null) {
    yield cursor;
    cursor = cursor.right;
  }
}

// ------------------------------------------------------------------
// Exported public types
// ------------------------------------------------------------------

interface DiffSpan {
  position: number;
  content: string;
  length: number;
}

interface StackItemDiff {
  insertions: DiffSpan[];
  deletions: DiffSpan[];
}

// ------------------------------------------------------------------
// Diff synthesis
// ------------------------------------------------------------------

/**
 * Classify each `ContentString` Item in `ytext` against a StackItem's
 * insertion / deletion DeleteSets to produce both raw span lists and the
 * reconstructed `before` / `after` strings.
 *
 * Algorithm:
 *   for each Item in ytext in document order:
 *     isBurstInsert = item ∈ stackItem.insertions
 *     isBurstDelete = item ∈ stackItem.deletions
 *
 *     `after` (current state): item contributes iff `!item.deleted`.
 *     `before` (pre-burst):    item contributes iff
 *       isBurstDelete  ||  (!item.deleted && !isBurstInsert)
 *     Insertion span emitted for burst-inserted + currently-live items.
 *     Deletion  span emitted for burst-deleted tombstones.
 *
 * `Y.UndoManager.keepItem(item, true)` at capture guarantees tombstone
 * content readability while the StackItem is on the stack.
 */
export function synthesizeStackItemDiff(
  stackItem: YjsStackItemShape,
  ytext: Y.Text,
): StackItemDiff & { before: string; after: string } {
  const insertions: DiffSpan[] = [];
  const deletions: DiffSpan[] = [];

  // Step 1: classification via yjs's public iterateDeletedStructs. Wrap in a
  // throwaway transact because iterateDeletedStructs needs a Transaction to
  // resolve struct IDs against the live store.
  const doc = ytext.doc;
  const burstInserts = new Set<Item>();
  const burstDeletes = new Set<Item>();
  if (doc) {
    doc.transact((tr) => {
      collectItemsInDeleteSet(tr, stackItem.insertions, burstInserts);
      collectItemsInDeleteSet(tr, stackItem.deletions, burstDeletes);
    });
  }

  // Step 2: single pass over the Y.Text Item chain in document order.
  let beforeStr = '';
  let afterStr = '';
  let posInBefore = 0;
  let posInAfter = 0;

  for (const item of walkYTextItems(ytext)) {
    if (!(item.content instanceof ContentString)) continue; // skip formatting / embeds

    const str = item.content.str;
    const len = str.length;
    const isBurstInsert = burstInserts.has(item);
    const isBurstDelete = burstDeletes.has(item);

    if (!item.deleted) {
      afterStr += str;
      if (isBurstInsert) {
        insertions.push({ position: posInAfter, content: str, length: len });
      } else {
        // Existed before the burst (and was not inserted by it).
        beforeStr += str;
        posInBefore += len;
      }
      posInAfter += len;
    } else if (isBurstDelete) {
      // Tombstoned in this burst → present in `before`, absent from `after`.
      deletions.push({ position: posInBefore, content: str, length: len });
      beforeStr += str;
      posInBefore += len;
    }
    // If deleted and NOT part of this burst: skip (not in before or after).
  }

  return { insertions, deletions, before: beforeStr, after: afterStr };
}

/**
 * Produce a unified-diff string for a single StackItem using the `diff`
 * package's `createPatch` (±3 context lines). Returns an empty string when
 * `before === after` so callers can render a placeholder rather than an
 * empty hunk.
 */
export function synthesizeStackItemDiffText(
  stackItem: YjsStackItemShape,
  ytext: Y.Text,
  docName: string,
): string {
  const { before, after } = synthesizeStackItemDiff(stackItem, ytext);
  if (before === after) return '';
  return createPatch(docName, before, after, undefined, undefined, { context: 3 });
}

// ------------------------------------------------------------------
// Activity listing
// ------------------------------------------------------------------

interface BurstStat {
  /** Index into `undoStack`: 0 = oldest, undoStack.length-1 = newest. */
  stackIndex: number;
  /** Capture timestamp in ms (stamped by `agent-sessions.ts`'s stack-item-added hook). */
  ts: number;
  additions: number;
  deletions: number;
}

interface AgentFileStat {
  docName: string;
  additionsTotal: number;
  deletionsTotal: number;
  lastTs: number;
  bursts: BurstStat[];
}

interface AgentActivityResult {
  sessionAlive: boolean;
  agent: { displayName: string; color: string; icon?: string; connectionId: string } | null;
  files: AgentFileStat[];
}

/** Read the capture timestamp from a StackItem. Falls back to `Date.now()` when unset. */
function getBurstTs(stackItem: YjsStackItemShape): number {
  const t = stackItem.meta.get('time');
  if (typeof t === 'number') return t;
  return Date.now();
}

/**
 * Count total additions and deletions for a StackItem by walking Y.Text's
 * Item chain once. Faster than `synthesizeStackItemDiff` when we only need
 * the +N / −M header numbers (avoids allocating the `before`/`after` strings).
 */
function countStackItemChanges(
  stackItem: YjsStackItemShape,
  ytext: Y.Text,
): { additions: number; deletions: number } {
  const doc = ytext.doc;
  const burstInserts = new Set<Item>();
  const burstDeletes = new Set<Item>();
  if (doc) {
    doc.transact((tr) => {
      collectItemsInDeleteSet(tr, stackItem.insertions, burstInserts);
      collectItemsInDeleteSet(tr, stackItem.deletions, burstDeletes);
    });
  }

  let additions = 0;
  let deletions = 0;
  for (const item of walkYTextItems(ytext)) {
    if (!(item.content instanceof ContentString)) continue;
    const len = item.content.str.length;
    if (!item.deleted && burstInserts.has(item)) additions += len;
    if (burstDeletes.has(item)) deletions += len;
  }
  return { additions, deletions };
}

/**
 * Enumerate every AgentSessionManager session for a given connectionId and
 * aggregate per-file + per-burst stats from `Y.UndoManager.undoStack`.
 *
 * The session map is queried via the typed `sessionsForConnection` accessor
 * — `(sessionManager as any).sessions` bypass is forbidden.
 *
 * Files ordered by most-recent-burst DESC; bursts by `stackIndex` DESC (newest first).
 */
export function listAgentActivity(
  sessionManager: AgentSessionManager,
  connectionId: string,
): AgentActivityResult {
  const fileStats: AgentFileStat[] = [];
  let agentInfo: AgentActivityResult['agent'] = null;
  let anySession = false;

  for (const session of sessionManager.sessionsForConnection(connectionId)) {
    anySession = true;
    // Extract agent identity from origin context (frozen at session creation).
    // `ctx.agent_type` holds the raw `clientName` (e.g. `"claude-code"`) per
    // `_createSession`; icon + color are derived via the same helpers used
    // by the presence bar + write handlers so all three surfaces render the
    // same glyph for the same agent.
    if (!agentInfo) {
      const ctx = session.origin.context as Record<string, unknown> | undefined;
      const clientName = typeof ctx?.agent_type === 'string' ? ctx.agent_type : undefined;
      const colorSeed = typeof ctx?.color_seed === 'string' ? ctx.color_seed : connectionId;
      const icon = iconFromClientName(clientName);
      const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(colorSeed);
      agentInfo = {
        displayName:
          (ctx?.display_name as string) ||
          (typeof ctx?.agent_type === 'string' ? ctx.agent_type : undefined) ||
          connectionId,
        color,
        icon,
        connectionId,
      };
    }

    const docName = session.docName;
    const um = session.um;
    const ytext = session.dc.document.getText('source');

    const bursts: BurstStat[] = [];
    for (let i = 0; i < um.undoStack.length; i++) {
      const stackItem = um.undoStack[i] as unknown as YjsStackItemShape;
      const ts = getBurstTs(stackItem);
      const { additions, deletions } = countStackItemChanges(stackItem, ytext);
      bursts.push({ stackIndex: i, ts, additions, deletions });
    }

    if (bursts.length === 0) continue; // Skip sessions with no recorded bursts.

    // Sort bursts newest first.
    bursts.sort((a, b) => b.stackIndex - a.stackIndex);

    const additionsTotal = bursts.reduce((sum, b) => sum + b.additions, 0);
    const deletionsTotal = bursts.reduce((sum, b) => sum + b.deletions, 0);
    const lastTs = Math.max(...bursts.map((b) => b.ts));

    fileStats.push({ docName, additionsTotal, deletionsTotal, lastTs, bursts });
  }

  if (!anySession) {
    return { sessionAlive: false, agent: null, files: [] };
  }

  // Sort files by most-recent burst DESC.
  fileStats.sort((a, b) => b.lastTs - a.lastTs);
  return {
    sessionAlive: true,
    agent: agentInfo,
    files: fileStats,
  };
}
