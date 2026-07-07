/**
 * React hook — install-state for every handoff target, plus a `refresh` fn.
 *
 * Cache policy:
 *   (1) boot-time probe fires once on mount,
 *   (2) the returned `refresh` can be called on dropdown-open (throttled to
 *       `DEFAULT_THROTTLE_MS` = 10 s per scheme),
 *   (3) state transitions fire via the coordinator's subscribe hook so the
 *       dropdown re-renders live without being closed.
 *
 * Host wiring:
 *   - Electron (`window.okDesktop` populated): `detectProtocol` IPC per scheme.
 *   - Web (`window.okDesktop` undefined): single `GET /api/installed-agents`.
 *
 * Defense-in-depth: web-host Cursor is always `installed: false` regardless of
 * server response — enforced inside `schemeStatesToTargetStates`.
 *
 * Repo convention (precedent set by `use-collab-url.ts`): behavior is tested
 * through the pure `createProbeCoordinator` primitive. This file is a thin
 * React wrapper; its tests assert shape + pure host-classifier semantics.
 */

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
// Side-effect import only — loads the `Window.okDesktop?` global augmentation.
import '@/lib/desktop-bridge-types';

/**
 * Pure host classifier — true when the Electron preload has populated
 * `window.okDesktop`. Test seam: accepts an optional `windowLike` so unit
 * tests don't depend on the actual DOM global.
 */
export function isElectronHostDefault(
  windowLike: { okDesktop?: unknown } | undefined = typeof window !== 'undefined'
    ? window
    : undefined,
): boolean {
  return windowLike?.okDesktop != null;
}

/**
 * Builds the ProbeDeps the React hook uses in production — chooses the IPC
 * or fetch strategy based on host. Exported for assertion in tests (we can't
 * render the hook directly without @testing-library/react per repo convention).
 */
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
    // Re-probe on window focus so a card stuck on "Install ↗" flips to
    // "Open" after the user installs the editor through any path (download
    // page, App Store, package manager) and returns to OK. The probe
    // coordinator's per-scheme 10s throttle prevents this from hammering
    // the IPC bridge on rapid focus events.
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
