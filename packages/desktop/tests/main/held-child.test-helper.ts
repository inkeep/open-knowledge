import { EventEmitter } from 'node:events';
import {
  heldChildServer,
  type SpawnedServer,
  type WindowManagerDeps,
} from '../../src/main/window-manager.ts';

type ExitRecord = ReturnType<SpawnedServer['readExit']>;

export function heldChild(
  deps: Pick<WindowManagerDeps, 'killProbe' | 'isProcessAlive'>,
  pid: number,
  readExit?: () => ExitRecord,
): SpawnedServer {
  const exitRecord =
    readExit ??
    ((): ExitRecord => (deps.isProcessAlive?.(pid) === false ? { code: 0, signal: null } : null));
  const child = Object.assign(new EventEmitter(), {
    kill: (signal: NodeJS.Signals): boolean => {
      if (exitRecord() !== null) return false;
      try {
        deps.killProbe(pid, signal);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') child.emit('error', err);
        return false;
      }
    },
  });
  child.on('error', () => {});
  return heldChildServer(child, pid, exitRecord);
}
