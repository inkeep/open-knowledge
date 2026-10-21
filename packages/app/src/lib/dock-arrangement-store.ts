import type { TerminalPlacement } from '@inkeep/open-knowledge-core/terminal-layout';
import { readAgentsPanelWidth } from './agents-panel-width-store';
import {
  bottomTerminalDockTree,
  DEFAULT_BOTTOM_TERMINAL_SHARE,
  DEFAULT_CHAT_SHARE,
  type DockNode,
  dockPaneDirection,
  dockPaneHeirShare,
  moveDockPane,
  parseDockTree,
} from './dock-tree';
import { scopedStorageKey } from './storage-scope';
import { readTerminalHeight } from './terminal-height-store';
import { readTerminalPlacement } from './terminal-placement-store';
import { readTerminalRightWidth } from './terminal-right-width-store';

const DOCK_ARRANGEMENT_KEY = 'ok-dock-arrangement-v1';
const UNMEASURED_RIGHT_TERMINAL_SHARE = 0.3;
const LEGACY_MIN_SHARE = 0.1;
const LEGACY_MAX_SHARE = 0.6;

type DockTerminalShares = Readonly<Record<TerminalPlacement, number>>;

export interface DockArrangement {
  readonly tree: DockNode;
  readonly terminalShares: DockTerminalShares;
}

export interface DockArrangementStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dockArrangementStorageKey(contentDir: string | null): string {
  return scopedStorageKey(DOCK_ARRANGEMENT_KEY, contentDir);
}

function parseTerminalShare(value: unknown): number | null {
  return typeof value === 'number' && value > 0 && value < 1 ? value : null;
}

function parseDockArrangement(value: unknown): DockArrangement | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const tree = parseDockTree(record.tree);
  const shares = record.terminalShares;
  if (tree === null || typeof shares !== 'object' || shares === null) return null;
  const bottom = parseTerminalShare((shares as Record<string, unknown>).bottom);
  const right = parseTerminalShare((shares as Record<string, unknown>).right);
  if (bottom === null || right === null) return null;
  return { tree, terminalShares: { bottom, right } };
}

export function readDockArrangement(
  key: string,
  storage?: DockArrangementStorage,
): DockArrangement | null {
  let raw: string | null;
  try {
    raw = (storage ?? localStorage).getItem(key);
  } catch (err) {
    console.warn(`[dock-arrangement-store] reading ${key} failed: ${String(err)}`);
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[dock-arrangement-store] stored ${key} record was not valid JSON; ignoring it: ${String(err)}`,
    );
    return null;
  }
  const arrangement = parseDockArrangement(parsed);
  if (arrangement === null) {
    console.warn(
      `[dock-arrangement-store] stored ${key} record is not a dock arrangement; ignoring it`,
    );
  }
  return arrangement;
}

export function writeDockArrangement(
  key: string,
  arrangement: DockArrangement,
  storage?: DockArrangementStorage,
): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(arrangement));
  } catch (err) {
    console.warn(`[dock-arrangement-store] writing ${key} failed: ${String(err)}`);
  }
}

export interface LegacyDockStorage {
  getItem(key: string): string | null;
}

export interface DockWorkspaceExtent {
  readonly widthPx: number;
  readonly heightPx: number;
}

function legacyShare(px: number | null, total: number, fallback: number): number {
  if (px === null || !Number.isFinite(px) || !Number.isFinite(total) || total <= 0) {
    return fallback;
  }
  return Math.min(Math.max(px / total, LEGACY_MIN_SHARE), LEGACY_MAX_SHARE);
}

// precedent #59: seeded from the retired app-global layout keys, which nothing writes any more.
function seededDockArrangement(
  workspace: DockWorkspaceExtent,
  source: LegacyDockStorage,
): DockArrangement {
  const chatShare = legacyShare(
    readAgentsPanelWidth(source),
    workspace.widthPx,
    DEFAULT_CHAT_SHARE,
  );
  const rightShare = legacyShare(
    readTerminalRightWidth(source),
    workspace.widthPx,
    UNMEASURED_RIGHT_TERMINAL_SHARE,
  );
  const bottomShare = legacyShare(
    readTerminalHeight(source, workspace.heightPx),
    workspace.heightPx,
    DEFAULT_BOTTOM_TERMINAL_SHARE,
  );
  const bottom: DockArrangement = {
    tree: bottomTerminalDockTree(chatShare, bottomShare),
    terminalShares: { bottom: bottomShare, right: rightShare },
  };
  return readTerminalPlacement(source) === 'right'
    ? withDockTerminalPlacement(bottom, 'right')
    : bottom;
}

function legacyStorage(storage: LegacyDockStorage | undefined): LegacyDockStorage {
  return {
    getItem(key) {
      try {
        return (storage ?? localStorage).getItem(key);
      } catch (err) {
        console.warn(`[dock-arrangement-store] reading ${key} failed: ${String(err)}`);
        return null;
      }
    },
  };
}

export function legacyDockArrangement(
  workspace: DockWorkspaceExtent,
  storage?: LegacyDockStorage,
): DockArrangement {
  return seededDockArrangement(workspace, legacyStorage(storage));
}

export function dockTerminalPlacement(tree: DockNode): TerminalPlacement {
  return dockPaneDirection(tree, 'terminal') === 'column' ? 'bottom' : 'right';
}

export function withDockTerminalPlacement(
  arrangement: DockArrangement,
  placement: TerminalPlacement,
): DockArrangement {
  const leaving = dockTerminalPlacement(arrangement.tree);
  if (leaving === placement) return arrangement;
  const leavingShare = dockPaneHeirShare(arrangement.tree, 'terminal');
  return {
    tree: moveDockPane(
      arrangement.tree,
      'terminal',
      'editor',
      placement === 'bottom' ? 'bottom' : 'end',
      arrangement.terminalShares[placement],
    ),
    terminalShares:
      leavingShare === null
        ? arrangement.terminalShares
        : { ...arrangement.terminalShares, [leaving]: leavingShare },
  };
}
