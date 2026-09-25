import type { ChildProcess } from 'node:child_process';

type SignalArgument = NodeJS.Signals | string | number | undefined;

interface SignalRecord {
  target: number;
  signal: SignalArgument;
}

export interface SignalBoundary {
  hold<T extends ChildProcess>(child: T): T;
  send(target: number, signal?: SignalArgument): true;
  readonly refused: readonly SignalRecord[];
  readonly delivered: readonly SignalRecord[];
  readonly probes: readonly SignalRecord[];
  readonly selfSignals: readonly SignalRecord[];
  restore(): void;
}

let active: SignalBoundary | undefined;

function isProbe(signal: SignalArgument): boolean {
  return signal === 0 || signal === '0';
}

function heldAndUnreaped(held: ReadonlySet<ChildProcess>, pid: number): boolean {
  for (const child of held) {
    if (child.pid === pid) return child.exitCode === null && child.signalCode === null;
  }
  return false;
}

export function installSignalBoundary(options: { deliverToHeldChildren: boolean }): SignalBoundary {
  if (active !== undefined) {
    throw new Error('a signal boundary is already installed; restore it before installing another');
  }
  const realKill = process.kill;
  const held = new Set<ChildProcess>();
  const refused: SignalRecord[] = [];
  const delivered: SignalRecord[] = [];
  const probes: SignalRecord[] = [];
  const selfSignals: SignalRecord[] = [];

  const send = (target: number, signal?: SignalArgument): true => {
    const record = { target, signal };
    if (!Number.isInteger(target) || Math.abs(target) <= 1) {
      refused.push(record);
      return true;
    }
    if (isProbe(signal)) {
      probes.push(record);
      return realKill.call(process, target, 0);
    }
    if (target === process.pid) {
      selfSignals.push(record);
      return true;
    }
    if (!options.deliverToHeldChildren || !heldAndUnreaped(held, Math.abs(target))) {
      refused.push(record);
      return true;
    }
    delivered.push(record);
    return realKill.call(process, target, signal);
  };

  const boundary: SignalBoundary = {
    hold(child) {
      held.add(child);
      return child;
    },
    send,
    refused,
    delivered,
    probes,
    selfSignals,
    restore() {
      if (active !== boundary) return;
      process.kill = realKill;
      active = undefined;
    },
  };

  process.kill = send as typeof process.kill;
  if (process.kill !== send) {
    process.kill = realKill;
    throw new Error('process.kill could not be replaced; refusing to run code that may signal');
  }
  active = boundary;
  return boundary;
}
