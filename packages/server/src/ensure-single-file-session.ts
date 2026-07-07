/**
 * Boot-on-demand for an out-of-project single file.
 *
 * When the MCP `preview_url` file branch finds no running session serving a
 * loose file, it calls `ensureSingleFileSession` to start one and wait until it
 * registers (writes a discoverable `ui.lock`), so the caller can then resolve
 * its URL via off-cwd discovery.
 *
 * Lifecycle: the session runs in a DETACHED `ok <file>` subprocess (headless,
 * `OK_SINGLE_FILE_NO_OPEN=1`) — NOT inside this MCP process — so it survives the
 * agent session and is cleaned up by the ephemeral reaper (idle-shutdown +
 * temp-dir delete), never leaking onto the MCP process's lifetime.
 *
 * Single-flight: concurrent ensures for the same file (keyed on realpath)
 * coalesce onto one spawn + wait, so two simultaneous opens never boot two
 * servers for one file.
 *
 * Spawn + resolve + clock are injected; `createEnsureSingleFileSession` wires
 * the production surface (self-spawn via this process's own CLI entry).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isSupportedDocFile } from './doc-extensions.ts';
import { createOffCwdResolverDeps, resolveOffCwdTarget } from './off-cwd-resolver.ts';

export interface EnsureSingleFileDeps {
  /** Spawn a detached, headless `ok <absFile>` that boots + registers a session. */
  readonly spawnSession: (absFile: string) => void;
  /** True when a running session already serves this realpath'd file. */
  readonly isServing: (absFile: string) => Promise<boolean>;
  /** Canonicalize a path; falls back to the input on failure. */
  readonly realpath: (p: string) => Promise<string>;
  /** Poll cadence while waiting for the spawned session to register. */
  readonly pollIntervalMs?: number;
  /** Give-up horizon for registration (cold boot can take a few seconds). */
  readonly timeoutMs?: number;
  /** Injected sleep (tests drive it deterministically). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected clock (tests drive it deterministically). */
  readonly now?: () => number;
}

// 500ms (not a tighter tick): every poll runs `isServing`, which re-runs the
// full `discoverLockDirs` process-scan (pgrep/lsof spawnSync). A cold `ok <file>`
// boot takes seconds anyway, so a coarser poll cuts the scan count over the
// timeout window by ~3x with no meaningful detection delay.
const DEFAULT_POLL_INTERVAL_MS = 500;
// Cold boot of a detached `ok <file>` includes a CLI/runtime cold start (in the
// packaged app, Electron-as-node) plus a Hocuspocus server boot before the
// session registers — comfortably more than a warm spawn. Give it headroom so
// the first `preview_url({file})` returns a URL (opens in the in-app browser)
// instead of timing out and pushing the agent to the `ok open` (Desktop) hint.
const DEFAULT_TIMEOUT_MS = 15000;

/** Module-level single-flight: realpath → in-flight ensure promise. */
const inflight = new Map<string, Promise<boolean>>();

/**
 * Ensure a running session serves `absFile`. Returns true once one is serving
 * it (already-running, or freshly spawned + registered within the timeout),
 * false if it did not register in time. Never throws for the wait path —
 * callers fall back to a "no session" hint on false.
 */
export function ensureSingleFileSession(
  absFile: string,
  deps: EnsureSingleFileDeps,
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (): Promise<boolean> => {
    const key = await deps.realpath(resolve(absFile)).catch(() => resolve(absFile));
    const existing = inflight.get(key);
    if (existing) return existing;

    const work = (async (): Promise<boolean> => {
      // isServing wraps off-cwd discovery, which can reject on an unexpected fs
      // error. Treat a rejection as "not serving yet" so this function honors
      // its never-throws contract — callers act on the boolean, not exceptions.
      const serving = () => deps.isServing(key).catch(() => false);
      if (await serving()) return true;
      deps.spawnSession(key);
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        await sleep(pollMs);
        if (await serving()) return true;
      }
      return false;
    })().finally(() => {
      inflight.delete(key);
    });

    inflight.set(key, work);
    return work;
  };

  return run();
}

/** Test-only: clear the single-flight map between cases. */
export function __resetEnsureSingleFileInflightForTests(): void {
  inflight.clear();
}

/**
 * Production boot-on-demand: spawn a DETACHED, headless `ok <file>` (this
 * process's own CLI entry) that boots + registers the session, and poll
 * off-cwd discovery until it appears. The detached child owns the session
 * (survives this MCP process) and self-reaps via the ephemeral reaper.
 *
 * A non-existent / non-markdown path is never spawned (the child would just
 * fail; skipping avoids a pointless wait — the caller then returns the
 * `ok open` hint).
 */
export function createEnsureSingleFileSession(): (absFile: string) => Promise<boolean> {
  const deps: EnsureSingleFileDeps = {
    spawnSession: (absFile) => {
      if (!isSupportedDocFile(absFile) || !existsSync(absFile)) return;
      const entry = process.argv[1];
      if (!entry) {
        // No CLI entry to re-spawn (embedded runtime / REPL). Spawning with an
        // empty entry would start a detached child that fails invisibly and
        // wastes the full poll timeout. Skip + log so the no-session result is
        // attributable rather than a silent dead end.
        process.stderr.write(
          '[ensure-single-file-session] process.argv[1] is empty — cannot spawn a single-file session\n',
        );
        return;
      }
      // Re-exec THIS runtime to run the CLI entry (`cli.mjs`) as a Node host.
      // In the packaged app `process.execPath` is the Electron binary, which
      // runs `entry` as Node ONLY with ELECTRON_RUN_AS_NODE=1 — set it
      // explicitly (matching `ok start` / `ok ui` / the `mcp` shim), not just
      // inherited. Do NOT strip it like the `ok open` LaunchServices path:
      // stripping launches the Electron GUI with `[cli.mjs, file]` as argv
      // instead of booting the headless single-file server, so `preview_url`
      // could never find a session.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OK_SINGLE_FILE_NO_OPEN: '1',
        ELECTRON_RUN_AS_NODE: '1',
      };
      const child = spawn(process.execPath, [entry, absFile], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.unref();
    },
    isServing: async (absFile) =>
      (await resolveOffCwdTarget(absFile, createOffCwdResolverDeps())) !== null,
    realpath: (p) => fsRealpath(p).catch(() => p),
  };
  return (absFile) => ensureSingleFileSession(absFile, deps);
}
