import { mark } from './index';

let pageListReadyAt: number | undefined;
let activeDocSyncedAt: number | undefined;
let reported = false;
let firstContentListener: ((firstContentMs: number) => void) | undefined;

export function onFirstContent(listener: (firstContentMs: number) => void): void {
  if (reported && pageListReadyAt !== undefined && activeDocSyncedAt !== undefined) {
    listener(Math.max(pageListReadyAt, activeDocSyncedAt));
    return;
  }
  firstContentListener = listener;
}

function maybeReport(): void {
  if (reported) return;
  if (pageListReadyAt === undefined || activeDocSyncedAt === undefined) return;
  reported = true;

  const firstContentMs = Math.max(pageListReadyAt, activeDocSyncedAt);
  const reportMarks =
    typeof window !== 'undefined' ? window.okDesktop?.startup?.reportMarks : undefined;
  reportMarks?.({ pageListReadyMs: pageListReadyAt, firstContentMs });
  firstContentListener?.(firstContentMs);
  firstContentListener = undefined;
}

export function pageListReady(): void {
  if (pageListReadyAt !== undefined) return;
  pageListReadyAt = Date.now();
  mark('ok/startup/page-list-ready');
  maybeReport();
}

export function firstContent(): void {
  if (activeDocSyncedAt !== undefined) return;
  activeDocSyncedAt = Date.now();
  mark('ok/startup/first-content');
  maybeReport();
}

export function __resetStartupMarksForTest(): void {
  pageListReadyAt = undefined;
  activeDocSyncedAt = undefined;
  reported = false;
  firstContentListener = undefined;
}
