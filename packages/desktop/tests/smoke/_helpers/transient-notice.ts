import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { requirePositiveTimeout } from './settled-reading';

export interface TransientNoticeObservation {
  startObserving: (notice: string) => Promise<void>;
  trigger: () => Promise<void>;
  readObserved: () => Promise<readonly string[]>;
  stopObserving?: () => Promise<void>;
}

export interface TransientNoticeOptions {
  timeout: number;
}

export interface TransientNoticeRecorder {
  record: (args: { key: string; notices: readonly string[] }) => void;
  read: (key: string) => string[] | null;
  stop: (key: string) => void;
}

export interface TransientNoticePageOptions {
  trigger: () => Promise<void>;
  document: 'next' | 'current';
  recorder?: TransientNoticeRecorder;
}

export async function expectNoticeFromTrigger(
  notice: string,
  { startObserving, trigger, readObserved, stopObserving }: TransientNoticeObservation,
  { timeout }: TransientNoticeOptions,
): Promise<void> {
  requirePositiveTimeout('expectNoticeFromTrigger', timeout);
  await startObserving(notice);
  try {
    await trigger();
    await expect.poll(readObserved, { timeout }).toContain(notice);
  } catch (verdict) {
    await stopObserving?.().catch((stopFailure: unknown) => {
      const reason = stopFailure instanceof Error ? stopFailure.message : String(stopFailure);
      console.warn(
        `[transient-notice] could not stop observing "${notice}" after its verdict failed: ${reason}`,
      );
    });
    throw verdict;
  }
  await stopObserving?.();
}

export function transientNoticeObservation(
  page: Page,
  { trigger, document: arming, recorder = pageRecorder }: TransientNoticePageOptions,
): TransientNoticeObservation {
  const key = `__okTransientNotices:${randomUUID()}`;
  let observed = '';
  let initScript: { dispose: () => Promise<void> } | undefined;
  return {
    async startObserving(notice) {
      observed = notice;
      const args = { key, notices: [notice] };
      if (arming === 'next') {
        initScript = await page.addInitScript(recorder.record, args);
      } else {
        await page.evaluate(recorder.record, args);
      }
    },
    trigger,
    async readObserved() {
      const seen = await page.evaluate(recorder.read, key);
      if (seen === null) {
        throw new Error(
          `the transient-notice recorder is not installed in the current document, so "${observed}" could not be observed there`,
        );
      }
      return seen;
    },
    async stopObserving() {
      try {
        await page.evaluate(recorder.stop, key);
      } finally {
        await initScript?.dispose();
      }
    },
  };
}

interface TransientNoticeRecord {
  readonly seen: string[];
  readonly flush: () => void;
  readonly observer: MutationObserver;
}

function recordTransientNotices({ key, notices }: { key: string; notices: readonly string[] }) {
  const realm = window as unknown as Record<string, unknown>;
  if (realm[key] !== undefined) return;
  const normalize = (text: string | null): string => (text ?? '').replace(/\s+/gu, ' ').trim();
  const watched = notices.map((notice) => ({ notice, text: normalize(notice) }));
  const seen: string[] = [];
  const pending = new Map<Element, string>();
  const carries = (element: Element, text: string): boolean =>
    normalize(element.textContent).includes(text);
  const innermost = (root: Element, text: string): Element[] => {
    const inner = [...root.children].filter((child) => carries(child, text));
    return inner.length === 0 ? [root] : inner.flatMap((child) => innermost(child, text));
  };
  const consider = (root: Element, wholeSubtreeIsNew: boolean): void => {
    for (const { notice, text } of watched) {
      if (!carries(root, text)) continue;
      for (const candidate of innermost(root, text)) {
        if (wholeSubtreeIsNew || candidate === root) pending.set(candidate, notice);
      }
    }
  };
  const isVisible = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const flush = (): void => {
    for (const [candidate, notice] of pending) {
      if (!candidate.isConnected) {
        pending.delete(candidate);
      } else if (isVisible(candidate)) {
        if (!seen.includes(notice)) seen.push(notice);
        pending.delete(candidate);
      }
    }
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) consider(node, true);
          else if (node.parentElement !== null) consider(node.parentElement, false);
        }
      } else if (mutation.type === 'characterData' && mutation.target.parentElement !== null) {
        consider(mutation.target.parentElement, false);
      }
    }
    flush();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });
  const record: TransientNoticeRecord = { seen, flush, observer };
  Object.defineProperty(realm, key, { value: record });
}

function readTransientNotices(key: string): string[] | null {
  const record = (window as unknown as Record<string, TransientNoticeRecord | undefined>)[key];
  if (record === undefined) return null;
  record.flush();
  return [...record.seen];
}

function stopTransientNotices(key: string): void {
  (window as unknown as Record<string, TransientNoticeRecord | undefined>)[
    key
  ]?.observer.disconnect();
}

const pageRecorder: TransientNoticeRecorder = {
  record: recordTransientNotices,
  read: readTransientNotices,
  stop: stopTransientNotices,
};
