import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

/**
 * Which launchable CLIs are on PATH, from the desktop probe (cached ~60s in
 * main). Shared by every launch entry point — the header / tab-strip "New chat",
 * the "Ask X" bubble, and the Open-with-AI menus — so they resolve and gate the
 * same installed set.
 *
 * Starts empty (unknown, not "none installed") until the async probe resolves.
 * A partial/older bridge, the web host with no `terminal` surface, or a probe
 * failure leaves keys `undefined` (unknown). Consumers must NOT read unknown as
 * "absent": `resolveDefaultCli` treats it optimistically, and `visibleTerminalClis`
 * fails open (an unknown CLI still renders), so a probe miss never silently drops
 * an installed CLI from the launch surfaces for the whole session.
 *
 * Re-probes when the window regains focus so a CLI installed mid-session (the
 * user left to a terminal/installer and came back) appears without an app
 * restart, and a transient probe failure or a cold empty map self-heals. The
 * main-process 60s cache keeps repeat focus events cheap.
 */
export function useInstalledClis(): Partial<Record<TerminalCli, boolean>> {
  const [installedClis, setInstalledClis] = useState<Partial<Record<TerminalCli, boolean>>>({});
  useEffect(() => {
    const terminal = window.okDesktop?.terminal;
    // Capability-guard the method itself: a partial bridge (a pre-cliInstalledMap
    // build, or a session-only stub) must skip the probe, never throw a
    // synchronous "not a function" the .catch can't intercept.
    if (typeof terminal?.cliInstalledMap !== 'function') return;
    let cancelled = false;
    const probe = () => {
      void terminal
        .cliInstalledMap()
        .then((map) => {
          if (!cancelled) setInstalledClis(map);
        })
        .catch((err) => {
          // Recoverable: unknown keys stay unknown (fail-open visibility; claude
          // auto-pick default). warn + [terminal] matches the surface convention.
          console.warn('[terminal] cliInstalledMap probe failed:', err);
        });
    };
    probe();
    window.addEventListener('focus', probe);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', probe);
    };
  }, []);
  return installedClis;
}
