import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

/**
 * Which launchable CLIs are on PATH, from the desktop probe (cached ~60s in
 * main). Shared by every default-CLI entry point — the header / tab-strip
 * "New chat" and the "Ask X" bubble — so they resolve the same installed set.
 *
 * Starts empty (unknown, not "none installed") until the async probe resolves;
 * `resolveDefaultCli` treats an unknown key optimistically. Capability-guarded:
 * a partial/older bridge, or the web host with no `terminal` surface, leaves the
 * map empty, and a probe failure degrades silently to "none installed" (New chat
 * then defaults to claude and the existing install banner handles the miss).
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
    void terminal
      .cliInstalledMap()
      .then((map) => {
        if (!cancelled) setInstalledClis(map);
      })
      .catch((err) => {
        // Recoverable: the resolver degrades to "none installed" → claude default.
        // warn + [terminal] matches the terminal surface's probe-failure convention.
        console.warn('[terminal] cliInstalledMap probe failed; defaulting to none installed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return installedClis;
}
