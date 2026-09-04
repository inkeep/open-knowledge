export interface BackgroundThrottleReporterDeps {
  enabled: boolean;
  hasAnyUnsyncedWork: () => boolean;
  addUnsyncedWorkListener: (cb: () => void) => () => void;
  report: (signal: { hasPendingWork: boolean; enabled: boolean }) => void;
}

export function installBackgroundThrottleReporter(
  deps: BackgroundThrottleReporterDeps,
): () => void {
  let lastReported: boolean | null = null;
  const push = (): void => {
    const hasPendingWork = deps.hasAnyUnsyncedWork();
    if (hasPendingWork === lastReported) return;
    lastReported = hasPendingWork;
    deps.report({ hasPendingWork, enabled: deps.enabled });
  };
  push();
  return deps.addUnsyncedWorkListener(push);
}
