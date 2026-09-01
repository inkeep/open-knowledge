import { getLogger } from './logger.ts';

const log = getLogger('shadow-op-gate');

const EXCLUSIVE_WAIT_WARN_MS = 60_000;

export class ShadowOpGate {
  private mutatorCount = 0;
  private exclusiveHeld: Promise<void> | null = null;
  private drainWaiters: Array<() => void> = [];

  get activeMutators(): number {
    return this.mutatorCount;
  }

  get isExclusiveHeld(): boolean {
    return this.exclusiveHeld !== null;
  }

  async withMutator<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusiveHeld) await this.exclusiveHeld;
    this.mutatorCount += 1;
    try {
      return await fn();
    } finally {
      this.mutatorCount -= 1;
      if (this.mutatorCount === 0) {
        for (const wake of this.drainWaiters.splice(0)) wake();
      }
    }
  }

  async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const waitStart = performance.now();
    for (;;) {
      if (this.exclusiveHeld) {
        await this.exclusiveHeld;
        continue;
      }
      if (this.mutatorCount > 0) {
        await new Promise<void>((r) => {
          this.drainWaiters.push(r);
        });
        continue;
      }
      break;
    }
    const waitedMs = performance.now() - waitStart;
    if (waitedMs > EXCLUSIVE_WAIT_WARN_MS) {
      log.warn(
        { waitedMs: Math.round(waitedMs) },
        '[shadow-op-gate] exclusive acquisition waited a long time for the mutator drain — sustained write stream is starving maintenance',
      );
    }
    let release!: () => void;
    this.exclusiveHeld = new Promise<void>((r) => {
      release = r;
    });
    try {
      return await fn();
    } finally {
      this.exclusiveHeld = null;
      release();
    }
  }

  async drain(): Promise<void> {
    if (this.mutatorCount === 0) return;
    await new Promise<void>((r) => {
      this.drainWaiters.push(r);
    });
  }
}

const gates = new Map<string, ShadowOpGate>();

export function shadowOpGateFor(shadow: { gitDir: string }): ShadowOpGate {
  let gate = gates.get(shadow.gitDir);
  if (!gate) {
    gate = new ShadowOpGate();
    gates.set(shadow.gitDir, gate);
  }
  return gate;
}

export function releaseShadowOpGate(gitDir: string): void {
  gates.delete(gitDir);
}
