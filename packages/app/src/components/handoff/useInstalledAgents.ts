
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import {
  createProbeCoordinator,
  initialTargetStates,
  type ProbeDeps,
  type ProbeHandle,
  probeViaElectron,
  probeViaFetch,
  type SchemeStates,
} from '@/lib/handoff/install-detect';
import '@/lib/desktop-bridge-types';

export function isElectronHostDefault(
  windowLike: { okDesktop?: unknown } | undefined = typeof window !== 'undefined'
    ? window
    : undefined,
): boolean {
  return windowLike?.okDesktop != null;
}

export function defaultProbeDeps(): ProbeDeps {
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (bridge) {
    const detector = (scheme: string) => bridge.shell.detectProtocol(scheme);
    return {
      probe: (): Promise<SchemeStates> => probeViaElectron({ detectProtocol: detector }),
      isElectronHost: () => true,
      now: Date.now,
    };
  }
  const fetchFn = globalThis.fetch.bind(globalThis);
  return {
    probe: (): Promise<SchemeStates> => probeViaFetch({ fetch: fetchFn }),
    isElectronHost: () => false,
    now: Date.now,
  };
}

interface UseInstalledAgentsResult {
  states: Record<HandoffTarget, InstallState>;
  refresh: () => Promise<void>;
}

export function useInstalledAgents(): UseInstalledAgentsResult {
  const [states, setStates] = useState<Record<HandoffTarget, InstallState>>(() =>
    initialTargetStates({ isElectronHost: isElectronHostDefault(), now: Date.now }),
  );
  const handleRef = useRef<ProbeHandle | null>(null);

  useEffect(() => {
    const handle = createProbeCoordinator(defaultProbeDeps());
    handleRef.current = handle;
    const unsub = handle.subscribe(setStates);
    void handle.probe();
    const onFocus = () => {
      void handle.probe();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      unsub();
      handle.cancel();
      handleRef.current = null;
    };
  }, []);

  return {
    states,
    refresh: () => handleRef.current?.probe() ?? Promise.resolve(),
  };
}
