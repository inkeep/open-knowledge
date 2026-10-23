import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signalSlidevChild } from './slidev-server.ts';

const sends = vi.hoisted(() => ({
  records: [] as Array<{
    route: string;
    target?: number;
    signal?: number | string;
    command?: string;
    args?: readonly string[];
  }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...original,
    spawn: (command: string, args: readonly string[]) => {
      sends.records.push({ route: 'spawn', command, args });
      const utility = Object.assign(new Emitter(), {
        kill: (signal?: string) => {
          sends.records.push({ route: 'utility-handle', signal });
          return true;
        },
      });
      queueMicrotask(() => utility.emit('exit', 0, null));
      return utility;
    },
  };
});

beforeEach(() => {
  sends.records.length = 0;
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    sends.records.push({ route: 'process', target, signal });
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const cases = [
  { platform: 'darwin', requested: 'SIGTERM' },
  { platform: 'darwin', requested: 'SIGKILL' },
  { platform: 'win32', requested: 'SIGTERM' },
  { platform: 'win32', requested: 'SIGKILL' },
] as const;

describe('Slidev signal exit', () => {
  it.each(cases)(
    'keeps $platform child stopped after signal exit when $requested is requested',
    async ({ platform, requested }) => {
      const lifecycle: {
        -readonly [K in 'pid' | 'exitCode' | 'signalCode' | 'kill']: ChildProcess[K];
      } = {
        pid: 4321,
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
          sends.records.push({ route: 'child-handle', target: 4321, signal });
          return true;
        },
      };
      const child = Object.assign(new EventEmitter(), lifecycle);
      const heldChild = child as ChildProcess;
      const killWindowsTree = async (target: number) => {
        sends.records.push({ route: 'tree', target });
      };
      await signalSlidevChild(heldChild, requested, { platform, killWindowsTree });
      expect(sends.records).toEqual([
        platform === 'win32'
          ? { route: 'tree', target: 4321 }
          : { route: 'process', target: -4321, signal: requested },
      ]);
      sends.records.length = 0;
      child.signalCode = 'SIGTERM';
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe('SIGTERM');
      await signalSlidevChild(heldChild, requested, { platform, killWindowsTree });
      expect(sends.records).toEqual([]);
    },
  );
});
