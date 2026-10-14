import { docNameFromHash } from '@/lib/doc-hash';
import { isPaneId, type PaneId } from '@/lib/pane-visibility-store';
import { scopedStorageKey } from '@/lib/storage-scope';

const STORAGE_KEY = 'ok-narrow-workspace-v1';

export interface NarrowWorkspaceSession {
  selected: PaneId | null;
  lastInteracted: PaneId | null;
  recent: PaneId[];
  hidden: PaneId[];
}

function isPaneList(value: unknown): value is PaneId[] {
  return Array.isArray(value) && value.every(isPaneId) && new Set(value).size === value.length;
}

export function narrowWorkspaceSessionKey(namespace: string, host: 'desktop' | 'web'): string {
  return scopedStorageKey(STORAGE_KEY, `${host}:${namespace}`);
}

export function readNarrowWorkspaceSession(
  key: string,
  terminalAvailable: boolean,
): NarrowWorkspaceSession | undefined {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('version' in value)) return undefined;
    if (value.version !== 1 || !('selected' in value)) return undefined;
    if (value.selected !== null && !isPaneId(value.selected)) return undefined;
    if (value.selected === 'terminal' && !terminalAvailable) return undefined;
    const recent = 'recent' in value ? value.recent : [];
    const hidden = 'hidden' in value ? value.hidden : [];
    const lastInteracted = 'lastInteracted' in value ? value.lastInteracted : value.selected;
    if (!isPaneList(recent) || !isPaneList(hidden)) return undefined;
    if (value.selected !== null && hidden.includes(value.selected)) return undefined;
    if (lastInteracted !== null && !isPaneId(lastInteracted)) return undefined;
    return {
      selected: value.selected,
      lastInteracted: lastInteracted === 'terminal' && !terminalAvailable ? null : lastInteracted,
      recent: terminalAvailable ? recent : recent.filter((pane) => pane !== 'terminal'),
      hidden: terminalAvailable ? hidden : hidden.filter((pane) => pane !== 'terminal'),
    };
  } catch {
    return undefined;
  }
}

export function writeNarrowWorkspaceSession(key: string, session: NarrowWorkspaceSession): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ version: 1, ...session }));
  } catch {}
}

export function isExplicitInitialDocumentNavigation(): boolean {
  const navigation = window.performance.getEntriesByType('navigation')[0];
  return (
    navigation !== undefined &&
    'type' in navigation &&
    navigation.type === 'navigate' &&
    docNameFromHash(window.location.hash) !== null
  );
}
