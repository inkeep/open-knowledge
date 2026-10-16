import type { OkBugReportScreenshot } from '@inkeep/open-knowledge-core/logger-types';
import { useEffect, useState } from 'react';
import type { OkMenuActionOrigin } from '@/lib/desktop-bridge-types';
import { getLastPointerPosition } from '@/lib/pointer-position';

export interface BugReportCapture {
  readonly screenshot: OkBugReportScreenshot | null;
  readonly pointerMarked: boolean;
}

export const BUG_REPORT_NO_CAPTURE: BugReportCapture = Object.freeze({
  screenshot: null,
  pointerMarked: false,
});

const CAPTURING_ATTRIBUTE = 'data-bug-report-capturing';

let launcherHides = 0;

function hideLaunchers(): () => void {
  launcherHides += 1;
  document.documentElement.setAttribute(CAPTURING_ATTRIBUTE, '');
  return () => {
    launcherHides -= 1;
    if (launcherHides === 0) document.documentElement.removeAttribute(CAPTURING_ATTRIBUTE);
  };
}

const LAUNCHER_SELECTOR = '[data-bug-report-launcher]';
const LAUNCHER_LEAVE_TIMEOUT_MS = 1000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function showLaunchersOnceTheyLeave(show: () => void): Promise<void> {
  try {
    await nextFrame();
    await nextFrame();
    const leaving = Array.from(document.querySelectorAll<HTMLElement>(LAUNCHER_SELECTOR)).flatMap(
      (launcher) => launcher.getAnimations?.({ subtree: true }) ?? [],
    );
    await Promise.race([
      Promise.allSettled(leaving.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, LAUNCHER_LEAVE_TIMEOUT_MS)),
    ]);
  } finally {
    show();
  }
}

const CAPTURE_REVEAL_TIMEOUT_MS = 1200;

function markPointerPosition(): (() => void) | null {
  const position = getLastPointerPosition();
  if (position === null) return null;
  const marker = document.createElement('div');
  marker.className = 'ok-pointer-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.style.left = `${position.x}px`;
  marker.style.top = `${position.y}px`;
  document.body.append(marker);
  return () => marker.remove();
}

function shootAfterPaintedFrame(
  capture: () => Promise<OkBugReportScreenshot | null>,
): Promise<OkBugReportScreenshot | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (shot: OkBugReportScreenshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(revealTimer);
      resolve(shot);
    };
    const revealTimer = setTimeout(() => {
      console.warn(
        `[bug-report] screenshot capture did not settle within ${CAPTURE_REVEAL_TIMEOUT_MS}ms; revealing without one`,
      );
      settle(null);
    }, CAPTURE_REVEAL_TIMEOUT_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (settled) return;
        capture().then(settle, (err: unknown) => {
          console.warn('[bug-report] screenshot capture failed:', err);
          settle(null);
        });
      });
    });
  });
}

export async function captureBugReport(origin: OkMenuActionOrigin): Promise<BugReportCapture> {
  const capture = window.okDesktop?.bugReport?.captureScreenshot;
  if (typeof capture !== 'function') return BUG_REPORT_NO_CAPTURE;
  let showLaunchers: (() => void) | null = null;
  let removePointerMarker: (() => void) | null = null;
  try {
    if (origin.launcherBorne) showLaunchers = hideLaunchers();
    else removePointerMarker = markPointerPosition();
    const screenshot = await shootAfterPaintedFrame(capture);
    return { screenshot, pointerMarked: screenshot !== null && removePointerMarker !== null };
  } finally {
    removePointerMarker?.();
    if (showLaunchers !== null) void showLaunchersOnceTheyLeave(showLaunchers);
  }
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'capturing'; readonly pending: Promise<BugReportCapture> }
  | { readonly kind: 'open' };

const IDLE: Phase = { kind: 'idle' };

export interface BugReportController {
  start(origin: OkMenuActionOrigin, beforeOpen?: () => void): void;
  close(): void;
}

export function createBugReportController(
  onChange: (capture: BugReportCapture | null) => void,
): BugReportController {
  let phase: Phase = IDLE;
  return {
    start(origin, beforeOpen) {
      if (phase.kind !== 'idle') return;
      const pending = captureBugReport(origin);
      phase = { kind: 'capturing', pending };
      const current = () => phase.kind === 'capturing' && phase.pending === pending;
      void pending.then(
        (capture) => {
          if (!current()) return;
          phase = IDLE;
          beforeOpen?.();
          onChange(capture);
          phase = { kind: 'open' };
        },
        (err: unknown) => {
          if (current()) phase = IDLE;
          throw err;
        },
      );
    },
    close() {
      phase = IDLE;
      onChange(null);
    },
  };
}

export interface BugReportState extends BugReportController {
  readonly capture: BugReportCapture | null;
}

export function useBugReport(): BugReportState {
  const [capture, setCapture] = useState<BugReportCapture | null>(null);
  const [controller] = useState(() => createBugReportController(setCapture));
  useEffect(() => () => controller.close(), [controller]);
  return { capture, start: controller.start, close: controller.close };
}
