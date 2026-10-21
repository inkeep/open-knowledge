import type { DocNoticeWire } from '@inkeep/open-knowledge-core';
import type { FileObservation } from './disk-receipts.ts';

export type VisibleHoldCause = Extract<DocNoticeWire, { kind: 'save-held' }>['cause'];

export type SaveHold =
  | {
      readonly kind: 'held';
      readonly cause: 'unreadable' | 'edits-changing' | 'no-history-or-backup' | 'keeps-changing';
    }
  | {
      readonly kind: 'held';
      readonly cause: 'not-utf8';
      readonly path: string;
      readonly observation: FileObservation;
    };

export function heldFor(cause: Exclude<SaveHold['cause'], 'not-utf8'>): SaveHold {
  return { kind: 'held', cause };
}

export function heldNotUtf8(path: string, observation: FileObservation): SaveHold {
  return { kind: 'held', cause: 'not-utf8', path, observation };
}

export function visibleHoldCause(hold: SaveHold): VisibleHoldCause | null {
  switch (hold.cause) {
    case 'no-history-or-backup':
    case 'keeps-changing':
    case 'not-utf8':
    case 'unreadable':
      return hold.cause;
    case 'edits-changing':
      return null;
    default:
      return assertNeverHold(hold);
  }
}

function assertNeverHold(hold: never): never {
  throw new Error(`unhandled save hold: ${JSON.stringify(hold)}`);
}
