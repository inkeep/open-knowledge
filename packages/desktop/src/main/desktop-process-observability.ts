export const DESKTOP_PROCESS_SAMPLE_INTERVAL_MS = 60_000;
export const MAX_DESKTOP_PROCESS_SAMPLE_ROWS = 12;
export const MAX_DESKTOP_WINDOW_SAMPLE_ROWS = 8;

export interface ProcessMetricLike {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  creationTime: number;
  cpu: {
    percentCPUUsage: number;
    cumulativeCPUUsage?: number;
    idleWakeupsPerSecond: number;
  };
  memory: {
    workingSetSize: number;
    peakWorkingSetSize: number;
    privateBytes?: number;
  };
  sandboxed?: boolean;
  integrityLevel?: string;
}

interface ObservedWebContents {
  readonly id: number;
  getOSProcessId(): number;
  isCrashed(): boolean;
  isDestroyed(): boolean;
  isLoading(): boolean;
}

type WindowLifecycleEvent = 'closed' | 'show' | 'hide' | 'minimize' | 'restore';

export interface ObservedBrowserWindow {
  readonly id: number;
  readonly webContents: ObservedWebContents;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  on(event: WindowLifecycleEvent, listener: () => void): void;
}

interface ProcessSample {
  pid: number;
  type: string;
  creationTime: number;
  name?: string;
  cumulativeCpuSeconds?: number;
  workingSetSizeKb: number;
  privateBytesKb?: number;
}

interface WindowSample {
  windowId: number | null;
  contentsId: number | null;
  rendererPid: number | null;
  state: 'alive' | 'loading' | 'crashed' | 'destroyed';
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

interface DesktopProcessSample {
  capturedAt: string;
  processCount: number;
  processesTruncated: number;
  processes: ProcessSample[];
  windowCount: number;
  windowsTruncated: number;
  windows: WindowSample[];
}

export interface DesktopCrashProcessSnapshot {
  affectedRenderer: { contentsId: number; rendererPid: number | null } | null;
  lastSampleAgeMs: number | null;
  lastSample: DesktopProcessSample | null;
  liveSample: DesktopProcessSample | null;
}

interface WindowIdentity {
  windowId: number | null;
  contentsId: number | null;
}

interface DesktopProcessLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface DesktopProcessObservabilityDeps<IntervalHandle> {
  now(): Date;
  getAppMetrics(): readonly ProcessMetricLike[];
  getAllWindows(): readonly ObservedBrowserWindow[];
  logger: DesktopProcessLogger;
  setInterval(callback: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

export interface DesktopProcessObservability {
  start(): void;
  stop(): void;
  sampleNow(trigger: 'renderer-ready'): void;
  observeWindow(window: ObservedBrowserWindow): void;
  snapshotForCrash(affectedRenderer?: {
    contentsId: number;
    rendererPid: number | null;
  }): DesktopCrashProcessSnapshot;
}

function readBoolean(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function readRendererPid(contents: ObservedWebContents | null): number | null {
  if (contents === null) return null;
  try {
    const pid = contents.getOSProcessId();
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function boundedLabel(value: string | undefined): string | undefined {
  return value?.slice(0, 96);
}

function normalizeProcess(metric: ProcessMetricLike): ProcessSample {
  const name = boundedLabel(metric.name);
  return {
    pid: metric.pid,
    type: metric.type,
    creationTime: metric.creationTime,
    ...(name === undefined ? {} : { name }),
    ...(metric.cpu.cumulativeCPUUsage === undefined
      ? {}
      : { cumulativeCpuSeconds: metric.cpu.cumulativeCPUUsage }),
    workingSetSizeKb: metric.memory.workingSetSize,
    ...(metric.memory.privateBytes === undefined
      ? {}
      : { privateBytesKb: metric.memory.privateBytes }),
  };
}

function readWebContents(window: ObservedBrowserWindow): ObservedWebContents | null {
  try {
    return window.webContents;
  } catch {
    return null;
  }
}

function readWindowIdentity(window: ObservedBrowserWindow): WindowIdentity {
  let windowId: number | null = null;
  let contentsId: number | null = null;
  try {
    windowId = window.id;
  } catch {}
  const contents = readWebContents(window);
  if (contents !== null) {
    try {
      contentsId = contents.id;
    } catch {}
  }
  return { windowId, contentsId };
}

function inspectWindow(
  window: ObservedBrowserWindow,
  identity: WindowIdentity = readWindowIdentity(window),
): WindowSample {
  const destroyed = readBoolean(() => window.isDestroyed(), true);
  const contents = readWebContents(window);
  const contentsDestroyed =
    destroyed || contents === null || readBoolean(() => contents.isDestroyed(), true);
  const crashed = !contentsDestroyed && readBoolean(() => contents.isCrashed(), false);
  const loading = !contentsDestroyed && !crashed && readBoolean(() => contents.isLoading(), false);
  return {
    ...identity,
    rendererPid: contentsDestroyed ? null : readRendererPid(contents),
    state: contentsDestroyed ? 'destroyed' : crashed ? 'crashed' : loading ? 'loading' : 'alive',
    visible: !destroyed && readBoolean(() => window.isVisible(), false),
    minimized: !destroyed && readBoolean(() => window.isMinimized(), false),
    focused: !destroyed && readBoolean(() => window.isFocused(), false),
  };
}

export function createDesktopProcessObservability<IntervalHandle>(
  deps: DesktopProcessObservabilityDeps<IntervalHandle>,
): DesktopProcessObservability {
  let interval: IntervalHandle | undefined;
  let lastSample: DesktopProcessSample | null = null;
  const lastKnownRendererPids = new WeakMap<ObservedBrowserWindow, number>();

  const inspectTrackedWindow = (
    window: ObservedBrowserWindow,
    identity?: WindowIdentity,
  ): WindowSample => {
    const details = inspectWindow(window, identity);
    if (details.rendererPid !== null) {
      lastKnownRendererPids.set(window, details.rendererPid);
    } else if (details.state === 'crashed' || details.state === 'destroyed') {
      details.rendererPid = lastKnownRendererPids.get(window) ?? null;
    } else {
      lastKnownRendererPids.delete(window);
    }
    return details;
  };

  const capture = (): DesktopProcessSample | null => {
    try {
      const processes = deps
        .getAppMetrics()
        .map(normalizeProcess)
        .sort(
          (left, right) => right.workingSetSizeKb - left.workingSetSizeKb || left.pid - right.pid,
        );
      const windows = deps
        .getAllWindows()
        .map((window) => inspectTrackedWindow(window))
        .filter((window) => window.state !== 'destroyed')
        .sort(
          (left, right) =>
            (left.windowId ?? Number.MAX_SAFE_INTEGER) -
            (right.windowId ?? Number.MAX_SAFE_INTEGER),
        );
      return {
        capturedAt: deps.now().toISOString(),
        processCount: processes.length,
        processesTruncated: Math.max(0, processes.length - MAX_DESKTOP_PROCESS_SAMPLE_ROWS),
        processes: processes.slice(0, MAX_DESKTOP_PROCESS_SAMPLE_ROWS),
        windowCount: windows.length,
        windowsTruncated: Math.max(0, windows.length - MAX_DESKTOP_WINDOW_SAMPLE_ROWS),
        windows: windows.slice(0, MAX_DESKTOP_WINDOW_SAMPLE_ROWS),
      };
    } catch (err) {
      deps.logger.warn(
        { event: 'desktop-process-observability.sample-failed', err },
        'desktop process sample failed',
      );
      return null;
    }
  };

  const sample = (trigger: 'startup' | 'interval' | 'renderer-ready'): void => {
    const captured = capture();
    if (captured === null) return;
    lastSample = captured;
    deps.logger.info(
      { event: 'desktop-process-observability.sample', trigger, ...captured },
      'desktop process and window sample',
    );
  };

  const lifecycle = (
    window: ObservedBrowserWindow,
    action: 'created' | 'shown' | 'hidden' | 'minimized' | 'restored' | 'closed',
    identity: WindowIdentity,
  ): void => {
    const details = inspectTrackedWindow(window, identity);
    let liveWindowCount: number | null = null;
    try {
      liveWindowCount = deps
        .getAllWindows()
        .map((candidate) => inspectTrackedWindow(candidate))
        .filter((entry) => entry.state !== 'destroyed').length;
    } catch (err) {
      deps.logger.warn(
        { event: 'desktop-process-observability.window-count-failed', err },
        'desktop live-window count failed',
      );
    }
    deps.logger.info(
      {
        event: 'desktop-process-observability.window-lifecycle',
        action,
        liveWindowCount,
        ...details,
      },
      'desktop window lifecycle changed',
    );
  };

  return {
    start() {
      if (interval !== undefined) return;
      sample('startup');
      interval = deps.setInterval(() => sample('interval'), DESKTOP_PROCESS_SAMPLE_INTERVAL_MS);
    },
    stop() {
      if (interval === undefined) return;
      deps.clearInterval(interval);
      interval = undefined;
    },
    sampleNow(trigger) {
      sample(trigger);
    },
    observeWindow(window) {
      const identity = readWindowIdentity(window);
      lifecycle(window, 'created', identity);
      window.on('show', () => lifecycle(window, 'shown', identity));
      window.on('hide', () => lifecycle(window, 'hidden', identity));
      window.on('minimize', () => lifecycle(window, 'minimized', identity));
      window.on('restore', () => lifecycle(window, 'restored', identity));
      window.on('closed', () => lifecycle(window, 'closed', identity));
    },
    snapshotForCrash(affectedRenderer) {
      const now = deps.now();
      const sampleAge =
        lastSample === null ? null : Math.max(0, now.getTime() - Date.parse(lastSample.capturedAt));
      const liveSample = capture();
      const lastAffectedWindow =
        affectedRenderer === undefined
          ? undefined
          : lastSample?.windows.find((window) => window.contentsId === affectedRenderer.contentsId);
      return {
        affectedRenderer:
          affectedRenderer === undefined
            ? null
            : {
                ...affectedRenderer,
                rendererPid:
                  affectedRenderer.rendererPid ?? lastAffectedWindow?.rendererPid ?? null,
              },
        lastSampleAgeMs: sampleAge,
        lastSample,
        liveSample,
      };
    },
  };
}
