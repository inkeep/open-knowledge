import { DEFAULT_SIGTERM_GRACE_MS, DEFAULT_SIGTERM_POLL_MS } from '@inkeep/open-knowledge-core';

export interface GracefulTerminateDeps {
  sendSignal(signal: 'SIGTERM' | 'SIGKILL'): void | Promise<void>;
  isAlive(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  graceMs?: number;
  pollMs?: number;
}

export async function gracefulTerminate(
  deps: GracefulTerminateDeps,
): Promise<{ escalated: boolean }> {
  const graceMs = deps.graceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const pollMs = deps.pollMs ?? DEFAULT_SIGTERM_POLL_MS;

  await deps.sendSignal('SIGTERM');
  const deadline = deps.now() + graceMs;
  while (deps.now() < deadline) {
    if (!deps.isAlive()) return { escalated: false };
    await deps.sleep(pollMs);
  }
  await deps.sendSignal('SIGKILL');
  return { escalated: true };
}
