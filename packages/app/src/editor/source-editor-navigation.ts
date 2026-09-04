import * as Y from 'yjs';
import type { OutlineNavDetail } from '@/components/OutlinePanel';
import type { LintNavDetail } from '@/components/ProblemsPanel';
import type { RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import type { BlockAnchor } from './mode-switch-position-resolver';

export interface NavigationPin {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
}

export interface SelectionOffsetNavigation {
  kind: 'selection-offset';
  intent?: 'toggle' | 'jump';
  anchor: BlockAnchor;
  pin?: NavigationPin;
}

type PendingSourceNavigation =
  | { kind: 'outline'; detail: OutlineNavDetail }
  | { kind: 'raw-mdx'; detail: RawMdxNavDetail }
  | { kind: 'lint'; detail: LintNavDetail }
  | SelectionOffsetNavigation;

type PendingWysiwygNavigation = SelectionOffsetNavigation;

const PENDING_NAVIGATION_TTL_MS = 30_000;

interface PendingNavigationEntry<T> {
  navigation: T;
  rememberedAt: number;
}

interface PendingNavigationStore<T> {
  remember(docName: string, navigation: T): void;
  peek(docName: string): T | null;
  consume(docName: string): T | null;
  clear(docName: string): void;
  clearForTest(): void;
}

function createPendingNavigationStore<T>(): PendingNavigationStore<T> {
  const entries = new Map<string, PendingNavigationEntry<T>>();
  const live = (entry: PendingNavigationEntry<T> | undefined): T | null => {
    if (!entry) return null;
    return Date.now() - entry.rememberedAt > PENDING_NAVIGATION_TTL_MS ? null : entry.navigation;
  };
  return {
    remember(docName, navigation) {
      entries.set(docName, { navigation, rememberedAt: Date.now() });
    },
    peek(docName) {
      return live(entries.get(docName));
    },
    consume(docName) {
      const entry = entries.get(docName);
      entries.delete(docName);
      return live(entry);
    },
    clear(docName) {
      entries.delete(docName);
    },
    clearForTest() {
      entries.clear();
    },
  };
}

const sourceNavigations = createPendingNavigationStore<PendingSourceNavigation>();
const wysiwygNavigations = createPendingNavigationStore<PendingWysiwygNavigation>();

export const rememberPendingSourceNavigation = sourceNavigations.remember;
export const peekPendingSourceNavigation = sourceNavigations.peek;
export const consumePendingSourceNavigation = sourceNavigations.consume;
export const clearPendingSourceNavigation = sourceNavigations.clear;
export const clearPendingSourceNavigationsForTest = sourceNavigations.clearForTest;

export const rememberPendingWysiwygNavigation = wysiwygNavigations.remember;
export const peekPendingWysiwygNavigation = wysiwygNavigations.peek;
export const consumePendingWysiwygNavigation = wysiwygNavigations.consume;
export const clearPendingWysiwygNavigation = wysiwygNavigations.clear;
export const clearPendingWysiwygNavigationsForTest = wysiwygNavigations.clearForTest;

export function clearPendingNavigationForExitedMode(
  docName: string,
  exitedMode: EditorModeValue,
): void {
  if (exitedMode === 'source') {
    clearPendingSourceNavigation(docName);
  } else {
    clearPendingWysiwygNavigation(docName);
  }
}

export function createNavigationPin(
  ytext: Y.Text,
  blockStart: number,
  blockEnd: number,
): NavigationPin {
  return {
    start: Y.createRelativePositionFromTypeIndex(ytext, blockStart),
    end: Y.createRelativePositionFromTypeIndex(ytext, blockEnd),
  };
}

export function resolveNavigationPin(pin: NavigationPin, ydoc: Y.Doc): number | null {
  const start = Y.createAbsolutePositionFromRelativePosition(pin.start, ydoc);
  const end = Y.createAbsolutePositionFromRelativePosition(pin.end, ydoc);
  if (start === null || end === null) return null;
  if (end.index <= start.index) return null;
  return start.index;
}
