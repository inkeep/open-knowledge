import { measureAnchor } from '@/components/scroll-restore';
import { mark } from '@/lib/perf/mark';
import type { EditorModeValue } from './use-editor-mode';

export interface DocScrollState {
  offset: number;
  mode: EditorModeValue;
  fraction: number;
}

export function scrollFraction(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, scrollTop / max));
}

export const MAX_TRACKED_DOC_SCROLL = 256;
const docScrollState = new Map<string, DocScrollState>();

export function rememberDocScrollState(docName: string, state: DocScrollState): void {
  docScrollState.delete(docName);
  docScrollState.set(docName, state);
  if (docScrollState.size > MAX_TRACKED_DOC_SCROLL) {
    const oldest = docScrollState.keys().next().value;
    if (oldest !== undefined) docScrollState.delete(oldest);
  }
}

export function getDocScrollState(docName: string): DocScrollState | undefined {
  return docScrollState.get(docName);
}

export const BODY_ANCHOR_ATTR = 'data-ok-body-anchor';

export function writeLandingResult(params: {
  docName: string;
  container: HTMLElement;
  targetScrollTop: number;
  mode: EditorModeValue;
  anchor?: HTMLElement | null;
}): void {
  const anchor =
    params.anchor ?? params.container.querySelector<HTMLElement>(`[${BODY_ANCHOR_ATTR}]`);
  const measurement = measureAnchor(params.container, anchor);
  const anchorPos = measurement.kind === 'measured' ? measurement.contentPos : 0;
  rememberDocScrollState(params.docName, {
    offset: params.targetScrollTop - anchorPos,
    mode: params.mode,
    fraction: scrollFraction(
      params.targetScrollTop,
      params.container.scrollHeight,
      params.container.clientHeight,
    ),
  });
}

export type ScrollHolder = 'landing' | 'navigation';

interface SuppressionCounts {
  landing: number;
  navigation: number;
}

const suppressedDocs = new Map<string, SuppressionCounts>();

let registryGeneration = 0;

interface ScrollRestoreSuppressionHandle {
  release(): void;
}

export function acquireScrollRestoreSuppression(
  docName: string,
  holder: ScrollHolder,
): ScrollRestoreSuppressionHandle {
  const counts = suppressedDocs.get(docName) ?? { landing: 0, navigation: 0 };
  counts[holder] += 1;
  suppressedDocs.set(docName, counts);
  const generation = registryGeneration;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (generation !== registryGeneration) return;
      const live = suppressedDocs.get(docName);
      if (!live) return;
      live[holder] = Math.max(0, live[holder] - 1);
      if (live.landing === 0 && live.navigation === 0) suppressedDocs.delete(docName);
    },
  };
}

export function scrollSuppressionHolder(docName: string): ScrollHolder | null {
  const counts = suppressedDocs.get(docName);
  if (!counts) return null;
  if (counts.landing > 0) return 'landing';
  if (counts.navigation > 0) return 'navigation';
  return null;
}

export function isScrollRestoreSuppressed(docName: string): boolean {
  return scrollSuppressionHolder(docName) !== null;
}

export interface LandingScrollOwner {
  yieldsToNavigation: boolean;
  supersede(): void;
}

const landingScrollOwners = new Map<string, Set<LandingScrollOwner>>();

export function registerLandingScrollOwner(
  docName: string,
  owner: LandingScrollOwner,
): { release(): void } {
  const owners = landingScrollOwners.get(docName) ?? new Set<LandingScrollOwner>();
  owners.add(owner);
  landingScrollOwners.set(docName, owners);
  return {
    release() {
      const live = landingScrollOwners.get(docName);
      if (!live) return;
      live.delete(owner);
      if (live.size === 0) landingScrollOwners.delete(docName);
    },
  };
}

const NAVIGATION_OWNERSHIP_MS = 600;

export type NavigationSeam =
  | 'outline'
  | 'deep-link'
  | 'problems-row'
  | 'raw-mdx'
  | 'find-match'
  | 'comment-reveal';

const NAVIGATION_DECLINED_MARK = 'ok/scroll-nav/declined';

const markedDeclines = new Map<string, Set<NavigationSeam>>();

export const MAX_TRACKED_DECLINE_DOCS = 32;

function shouldMarkDecline(docName: string, seam: NavigationSeam): boolean {
  const marked = markedDeclines.get(docName) ?? new Set<NavigationSeam>();
  markedDeclines.delete(docName);
  markedDeclines.set(docName, marked);
  if (markedDeclines.size > MAX_TRACKED_DECLINE_DOCS) {
    const oldest = markedDeclines.keys().next().value;
    if (oldest !== undefined) markedDeclines.delete(oldest);
  }
  if (marked.has(seam)) return false;
  marked.add(seam);
  return true;
}

const navigationHoldTimers = new Set<ReturnType<typeof setTimeout>>();

function holdScrollerForNavigation(docName: string): void {
  const suppression = acquireScrollRestoreSuppression(docName, 'navigation');
  const timer = setTimeout(() => {
    navigationHoldTimers.delete(timer);
    suppression.release();
  }, NAVIGATION_OWNERSHIP_MS);
  navigationHoldTimers.add(timer);
}

export function claimScrollerForNavigation(docName: string, seam: NavigationSeam): boolean {
  const owners = landingScrollOwners.get(docName);
  const superseding = owners ? Array.from(owners) : [];
  for (const owner of superseding) {
    if (!owner.yieldsToNavigation) {
      if (shouldMarkDecline(docName, seam)) {
        mark(NAVIGATION_DECLINED_MARK, { docName, seam, ownerCount: superseding.length });
      }
      return false;
    }
  }
  markedDeclines.delete(docName);
  holdScrollerForNavigation(docName);
  for (const owner of superseding) owner.supersede();
  return true;
}

export function runScrollNavigation(
  docName: string,
  seam: NavigationSeam,
  scroll: () => void,
): boolean {
  if (!claimScrollerForNavigation(docName, seam)) return false;
  scroll();
  return true;
}

export function __resetScrollRestoreCoordination(): void {
  for (const timer of navigationHoldTimers) clearTimeout(timer);
  navigationHoldTimers.clear();
  markedDeclines.clear();
  docScrollState.clear();
  suppressedDocs.clear();
  landingScrollOwners.clear();
  registryGeneration += 1;
}
