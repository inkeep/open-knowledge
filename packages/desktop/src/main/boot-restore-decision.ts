import { type RestoredWindow, restoreSurvivorPath, windowRestoreKey } from './state-store.ts';

export interface BootRestoreInput {
  pendingRestore: RestoredWindow[] | null;
  lastOpenedProject: string | null;
  optionHeld: boolean;
  pathExists: (p: string) => boolean;
  urlLaunch: boolean;
}

export type BootRestoreDecision =
  | { clearSnapshot: boolean; action: 'restore'; windows: RestoredWindow[] }
  | { clearSnapshot: boolean; action: 'lastOpened'; project: string }
  | { clearSnapshot: boolean; action: 'navigator' }
  | { clearSnapshot: boolean; action: 'none' };

export function bootRestoreDecision(input: BootRestoreInput): BootRestoreDecision {
  const { pendingRestore, lastOpenedProject, optionHeld, pathExists, urlLaunch } = input;
  const clearSnapshot = pendingRestore !== null;

  if (urlLaunch) {
    return { clearSnapshot, action: 'none' };
  }

  const restorable =
    pendingRestore !== null && !optionHeld
      ? pendingRestore.filter((w) => pathExists(restoreSurvivorPath(w)))
      : [];

  if (restorable.length > 0) {
    return { clearSnapshot, action: 'restore', windows: restorable };
  }
  if (
    pendingRestore === null &&
    lastOpenedProject !== null &&
    !optionHeld &&
    pathExists(lastOpenedProject)
  ) {
    return { clearSnapshot, action: 'lastOpened', project: lastOpenedProject };
  }
  return { clearSnapshot, action: 'navigator' };
}

export function resolveRestoreActions(
  windows: readonly RestoredWindow[],
  resolveFileTarget: (filePath: string) => RestoredWindow | null,
): { orderedKeys: string[]; actionByKey: Map<string, RestoredWindow> } {
  const orderedKeys: string[] = [];
  const actionByKey = new Map<string, RestoredWindow>();
  for (const w of windows) {
    let action: RestoredWindow;
    if (w.kind === 'file') {
      const resolved = resolveFileTarget(w.filePath);
      if (resolved === null) continue;
      action = resolved;
    } else {
      action = w;
    }
    const key = windowRestoreKey(action);
    const existingIdx = orderedKeys.indexOf(key);
    if (existingIdx !== -1) orderedKeys.splice(existingIdx, 1);
    orderedKeys.push(key);
    actionByKey.set(key, action);
  }

  const restoredProjects = new Set(
    [...actionByKey.values()]
      .filter(
        (action): action is Extract<RestoredWindow, { kind: 'project' }> =>
          action.kind === 'project',
      )
      .map((action) => action.projectPath),
  );
  const projectKeys: string[] = [];
  const docKeys: string[] = [];
  for (const key of orderedKeys) {
    const action = actionByKey.get(key);
    if (action?.kind !== 'doc') {
      projectKeys.push(key);
      continue;
    }
    if (restoredProjects.has(action.projectPath)) docKeys.push(key);
    else actionByKey.delete(key);
  }
  return { orderedKeys: [...projectKeys, ...docKeys], actionByKey };
}

export interface SettledBootRestoreInput extends Omit<BootRestoreInput, 'urlLaunch'> {
  urlLaunchOwnsWindow: () => boolean;
  waitForUrlLaunchSettled: () => Promise<void>;
}

export async function resolveBootRestoreDecision(
  input: SettledBootRestoreInput,
): Promise<BootRestoreDecision> {
  await input.waitForUrlLaunchSettled();
  return bootRestoreDecision({
    pendingRestore: input.pendingRestore,
    lastOpenedProject: input.lastOpenedProject,
    optionHeld: input.optionHeld,
    pathExists: input.pathExists,
    urlLaunch: input.urlLaunchOwnsWindow(),
  });
}
