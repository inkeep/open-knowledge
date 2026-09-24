import type { Page, Request } from '@playwright/test';
import { requireBoundMs } from './server-process.ts';

const OUTSTANDING_URLS_NAMED_ON_STALL = 5;

export function requireDeadlineAt(deadlineAt: number, callSite: string): number {
  if (typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) && deadlineAt > 0) {
    return deadlineAt;
  }
  throw new TypeError(
    `${callSite} needs its caller to name the instant it has to finish by, in milliseconds since the epoch, and received ${String(deadlineAt)}; a deadline that is not a positive finite instant ends the work it bounds at once and reads as that deadline having arrived, rather than as the caller's mistake it is`,
  );
}

export async function gotoWhileLoadProgresses(
  page: Page,
  url: string,
  stallMs: number,
  deadlineAt?: number,
  deadlineName = 'the deadline its caller set',
): Promise<void> {
  requireBoundMs(stallMs, 'gotoWhileLoadProgresses');
  const remainingMs =
    deadlineAt === undefined
      ? undefined
      : requireDeadlineAt(deadlineAt, 'gotoWhileLoadProgresses') - Date.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    throw new Error(
      `first load of ${url} was not started, because its caller had already reached ${deadlineName}`,
    );
  }
  const startedAt = Date.now();
  const outstanding = new Set<Request>();
  let issued = 0;
  let finished = 0;
  let failed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let refuse: (reason: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    refuse = reject;
  });
  const progressSoFar = (): string => {
    const named = [...outstanding]
      .slice(0, OUTSTANDING_URLS_NAMED_ON_STALL)
      .map((request) => request.url());
    const including = named.length === 0 ? '' : `, including ${named.join(', ')}`;
    return `${issued} requests issued, ${finished} finished, ${failed} failed, ${outstanding.size} still outstanding${including}`;
  };
  const refuseAsStalled = (): void => {
    refuse(
      new Error(
        `first load of ${url} made no network progress for ${stallMs}ms (${Date.now() - startedAt}ms after the navigation began): ${progressSoFar()}`,
      ),
    );
  };
  const refuseAtDeadline = (): void => {
    const progressClause =
      issued === 0
        ? ''
        : `, although it was still making network progress within every ${stallMs}ms`;
    refuse(
      new Error(
        `first load of ${url} had not finished ${Date.now() - startedAt}ms after the navigation began${progressClause}, when it reached ${deadlineName}: ${progressSoFar()}`,
      ),
    );
  };
  const rearmStallTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(refuseAsStalled, stallMs);
  };
  const onRequest = (request: Request): void => {
    issued += 1;
    outstanding.add(request);
    rearmStallTimer();
  };
  const onResponse = (): void => rearmStallTimer();
  const onFinished = (request: Request): void => {
    finished += 1;
    outstanding.delete(request);
    rearmStallTimer();
  };
  const onFailed = (request: Request): void => {
    failed += 1;
    outstanding.delete(request);
    rearmStallTimer();
  };
  try {
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    rearmStallTimer();
    if (remainingMs !== undefined) {
      deadlineTimer = setTimeout(refuseAtDeadline, remainingMs);
    }
    const navigation = page.goto(url, { timeout: 0 });
    await Promise.race([navigation, stalled]);
  } finally {
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  }
}
