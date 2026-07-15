import type { OutlineNavDetail } from '@/components/OutlinePanel';
import type { LintNavDetail } from '@/components/ProblemsPanel';
import type { RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';

type PendingSourceNavigation =
  | { kind: 'outline'; detail: OutlineNavDetail }
  | { kind: 'raw-mdx'; detail: RawMdxNavDetail }
  | { kind: 'lint'; detail: LintNavDetail };

/**
 * Discard-at-consume horizon. The replay effect fires on every source-mode
 * activation, not only the first mount after a click — so an intent banked
 * while the doc sat in WYSIWYG must expire, or a much-later mode switch would
 * jump the cursor to stale coordinates.
 */
const PENDING_NAVIGATION_TTL_MS = 30_000;

interface PendingNavigationEntry {
  navigation: PendingSourceNavigation;
  rememberedAt: number;
}

const pendingNavigations = new Map<string, PendingNavigationEntry>();

function liveNavigationOf(
  entry: PendingNavigationEntry | undefined,
): PendingSourceNavigation | null {
  if (!entry) return null;
  return Date.now() - entry.rememberedAt > PENDING_NAVIGATION_TTL_MS ? null : entry.navigation;
}

export function rememberPendingSourceNavigation(
  docName: string,
  navigation: PendingSourceNavigation,
): void {
  pendingNavigations.set(docName, { navigation, rememberedAt: Date.now() });
}

export function peekPendingSourceNavigation(docName: string): PendingSourceNavigation | null {
  return liveNavigationOf(pendingNavigations.get(docName));
}

export function consumePendingSourceNavigation(docName: string): PendingSourceNavigation | null {
  const entry = pendingNavigations.get(docName);
  pendingNavigations.delete(docName);
  return liveNavigationOf(entry);
}

export function clearPendingSourceNavigation(docName: string): void {
  pendingNavigations.delete(docName);
}

export function clearPendingSourceNavigationsForTest(): void {
  pendingNavigations.clear();
}
