import { AGENT_ICON_COLORS, colorFromSeed, iconFromClientName } from '@inkeep/open-knowledge-core';
import { createPatch } from 'diff';
import type * as Y from 'yjs';
import { ContentString, Item, iterateDeletedStructs } from 'yjs';
import type { AgentSessionManager } from './agent-sessions.ts';

interface YjsDeleteSetShape {
  clients: Map<number, Array<{ clock: number; len: number }>>;
}
interface YjsStackItemShape {
  insertions: YjsDeleteSetShape;
  deletions: YjsDeleteSetShape;
  meta: Map<unknown, unknown>;
}

function collectItemsInDeleteSet(
  tr: Y.Transaction,
  ds: YjsDeleteSetShape,
  intoInstances: Set<Item>,
): void {
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

function* walkYTextItems(ytext: Y.Text): IterableIterator<Item> {
  let cursor = (ytext as unknown as { _start: Item | null })._start;
  while (cursor !== null) {
    yield cursor;
    cursor = cursor.right;
  }
}

interface DiffSpan {
  position: number;
  content: string;
  length: number;
}

interface StackItemDiff {
  insertions: DiffSpan[];
  deletions: DiffSpan[];
}

export function synthesizeStackItemDiff(
  stackItem: YjsStackItemShape,
  ytext: Y.Text,
): StackItemDiff & { before: string; after: string } {
  const insertions: DiffSpan[] = [];
  const deletions: DiffSpan[] = [];

  const doc = ytext.doc;
  const burstInserts = new Set<Item>();
  const burstDeletes = new Set<Item>();
  if (doc) {
    doc.transact((tr) => {
      collectItemsInDeleteSet(tr, stackItem.insertions, burstInserts);
      collectItemsInDeleteSet(tr, stackItem.deletions, burstDeletes);
    });
  }

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
        beforeStr += str;
        posInBefore += len;
      }
      posInAfter += len;
    } else if (isBurstDelete) {
      deletions.push({ position: posInBefore, content: str, length: len });
      beforeStr += str;
      posInBefore += len;
    }
  }

  return { insertions, deletions, before: beforeStr, after: afterStr };
}

export function synthesizeStackItemDiffText(
  stackItem: YjsStackItemShape,
  ytext: Y.Text,
  docName: string,
): string {
  const { before, after } = synthesizeStackItemDiff(stackItem, ytext);
  if (before === after) return '';
  return createPatch(docName, before, after, undefined, undefined, { context: 3 });
}

interface BurstStat {
  stackIndex: number;
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

function getBurstTs(stackItem: YjsStackItemShape): number {
  const t = stackItem.meta.get('time');
  if (typeof t === 'number') return t;
  return Date.now();
}

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

export function listAgentActivity(
  sessionManager: AgentSessionManager,
  connectionId: string,
): AgentActivityResult {
  const fileStats: AgentFileStat[] = [];
  let agentInfo: AgentActivityResult['agent'] = null;
  let anySession = false;

  for (const session of sessionManager.sessionsForConnection(connectionId)) {
    anySession = true;
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

    bursts.sort((a, b) => b.stackIndex - a.stackIndex);

    const additionsTotal = bursts.reduce((sum, b) => sum + b.additions, 0);
    const deletionsTotal = bursts.reduce((sum, b) => sum + b.deletions, 0);
    const lastTs = Math.max(...bursts.map((b) => b.ts));

    fileStats.push({ docName, additionsTotal, deletionsTotal, lastTs, bursts });
  }

  if (!anySession) {
    return { sessionAlive: false, agent: null, files: [] };
  }

  fileStats.sort((a, b) => b.lastTs - a.lastTs);
  return {
    sessionAlive: true,
    agent: agentInfo,
    files: fileStats,
  };
}
