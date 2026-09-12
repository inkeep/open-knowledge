type GcHost = { gc?: () => void };

export const EXPOSE_GC_FLAG = '--expose-gc';

export function gcAvailable(): boolean {
  return typeof (globalThis as GcHost).gc === 'function';
}

export function collectGarbage(): void {
  (globalThis as GcHost).gc?.();
}

export function withForcedGc<T extends NodeJS.ProcessEnv>(
  env: T,
): Omit<T, 'NODE_OPTIONS'> & { NODE_OPTIONS: string } {
  const current = env.NODE_OPTIONS ?? '';
  if (current.split(/\s+/).includes(EXPOSE_GC_FLAG)) return { ...env, NODE_OPTIONS: current };
  return { ...env, NODE_OPTIONS: current ? `${current} ${EXPOSE_GC_FLAG}` : EXPOSE_GC_FLAG };
}
