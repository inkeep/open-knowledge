import type { ChildProcess } from 'node:child_process';
import { type ElectronApplication, expect } from '@playwright/test';

export interface ThemeSourcePushSource {
  process(): Pick<ChildProcess, 'stdout' | 'stderr'>;
}

export function observeThemeSourcePushes(app: ThemeSourcePushSource): ReadonlySet<number> {
  const senderWindowIds = new Set<number>();
  const absorbLines = () => {
    let pending = '';
    return (chunk: Buffer | string) => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const brace = line.indexOf('{');
        if (brace === -1) continue;
        let parsed: { event?: string; senderWindowId?: unknown };
        try {
          parsed = JSON.parse(line.slice(brace)) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.event === 'theme-source-set' && typeof parsed.senderWindowId === 'number') {
          senderWindowIds.add(parsed.senderWindowId);
        }
      }
    };
  };
  const proc = app.process();
  proc.stderr?.on('data', absorbLines());
  proc.stdout?.on('data', absorbLines());
  return senderWindowIds;
}

type ThemeSourceProbeFailure = 'probe-rejected' | 'probe-unanswered';

interface ProbedWindowIdentity {
  id: number;
  url: string;
  loading: boolean;
}

export type ThemeSourceWindowProbe =
  | (ProbedWindowIdentity & { bridge: 'present' | 'absent'; cause?: never })
  | (ProbedWindowIdentity & { bridge: ThemeSourceProbeFailure; cause: string });

interface ThemeSourcePushDebtIdentity {
  id: number;
  url: string;
}

export type ThemeSourcePushDebt =
  | (ThemeSourcePushDebtIdentity & { reason: 'owes'; cause?: never })
  | (ThemeSourcePushDebtIdentity & { reason: 'loading'; cause?: string })
  | (ThemeSourcePushDebtIdentity & { reason: ThemeSourceProbeFailure; cause: string });

export function windowsStillOwingAThemeSourcePush(
  windows: readonly ThemeSourceWindowProbe[],
  pushedBy: ReadonlySet<number>,
): readonly ThemeSourcePushDebt[] {
  const owed: ThemeSourcePushDebt[] = [];
  for (const probe of windows) {
    if (pushedBy.has(probe.id)) continue;
    const { id, url } = probe;
    if (probe.loading) {
      owed.push(
        probe.cause === undefined
          ? { id, url, reason: 'loading' }
          : { id, url, reason: 'loading', cause: probe.cause },
      );
      continue;
    }
    if (probe.bridge === 'probe-rejected') {
      owed.push({ id, url, reason: 'probe-rejected', cause: probe.cause });
      continue;
    }
    if (probe.bridge === 'probe-unanswered') {
      owed.push({ id, url, reason: 'probe-unanswered', cause: probe.cause });
      continue;
    }
    if (probe.bridge === 'absent') continue;
    owed.push({ id, url, reason: 'owes' });
  }
  return owed;
}

const NO_WINDOW_HAS_PUSHED: ReadonlySet<number> = new Set();

const ABANDON_UNANSWERED_BRIDGE_PROBE_AFTER_MS = 2_000;

const MAX_PROBE_FAILURE_CAUSE_CHARS = 200;

interface ProbedWebContents {
  getURL(): string;
  isLoading(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

interface ProbedWindow {
  id: number;
  isDestroyed(): boolean;
  webContents: ProbedWebContents;
}

interface ProbedElectron {
  BrowserWindow: { getAllWindows(): ProbedWindow[] };
}

interface ThemeSourceProbeLimits {
  abandonProbeAfterMs: number;
  maxCauseChars: number;
}

/* STOP: probeLiveWindowsInMain is serialized into the Electron main process through
   String(pageFunction), so it must stay closure-free and import-free. Values reach it
   only through the limits argument. */
export const probeLiveWindowsInMain = (
  { BrowserWindow }: ProbedElectron,
  limits: ThemeSourceProbeLimits,
): Promise<ThemeSourceWindowProbe[]> =>
  Promise.all(
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => {
        const id = win.id;
        const url = win.webContents.getURL();
        const loading = win.webContents.isLoading();
        return new Promise<ThemeSourceWindowProbe>((settle) => {
          const abandonProbe = setTimeout(
            () =>
              settle({
                id,
                url,
                loading,
                bridge: 'probe-unanswered',
                cause: `bridge probe went unanswered for ${limits.abandonProbeAfterMs}ms`,
              }),
            limits.abandonProbeAfterMs,
          );
          win.webContents
            .executeJavaScript('typeof window.okDesktop?.setThemeSource === "function"')
            .then((exposed: unknown) => {
              clearTimeout(abandonProbe);
              settle({ id, url, loading, bridge: exposed === true ? 'present' : 'absent' });
            })
            .catch((cause: unknown) => {
              clearTimeout(abandonProbe);
              settle({
                id,
                url,
                loading,
                bridge: 'probe-rejected',
                cause: (cause instanceof Error ? cause.message : String(cause)).slice(
                  0,
                  limits.maxCauseChars,
                ),
              });
            });
        });
      }),
  );

function probeLiveWindows(app: ElectronApplication): Promise<ThemeSourceWindowProbe[]> {
  return app.evaluate(probeLiveWindowsInMain, {
    abandonProbeAfterMs: ABANDON_UNANSWERED_BRIDGE_PROBE_AFTER_MS,
    maxCauseChars: MAX_PROBE_FAILURE_CAUSE_CHARS,
  });
}

export async function waitForEveryWindowToPushItsThemeSource(
  app: ElectronApplication,
  pushedBy: ReadonlySet<number>,
): Promise<void> {
  await expect(async () => {
    const windows = await probeLiveWindows(app);
    const couldOwe = windowsStillOwingAThemeSourcePush(windows, NO_WINDOW_HAS_PUSHED);
    expect(couldOwe.length).toBeGreaterThan(0);
    expect(windowsStillOwingAThemeSourcePush(windows, pushedBy)).toEqual([]);
  }).toPass({ timeout: 20_000 });
}
