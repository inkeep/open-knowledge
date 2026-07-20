/**
 * File mirror for the global MCP stdio server's stderr diagnostics.
 *
 * The stdio server's `[mcp]` breadcrumbs go to the host process's stderr —
 * which lands wherever the host keeps its own logs (e.g. Claude Desktop's
 * log folder), invisible to `ok bug-report`. This mirror appends a copy of
 * every diagnostic line to `~/.ok/logs/mcp.<YYYY-MM-DD>.log`, matching the
 * desktop logger's conventions in that directory (`desktop.<date>.log`
 * naming; 7-day age + aggregate-size retention), so the bug-report bundle's
 * user-log collection (`collectLogs` scans `~/.ok/logs/*.log`) picks it up
 * with no collector changes.
 *
 * Best-effort by design — the mirror is a diagnostics side-channel on the
 * agent-write ingress path, so a mirror failure must never break the MCP
 * server or its host-visible stderr. Every write swallows errors, and after
 * a run of consecutive failures the mirror disables itself for the rest of
 * the process to avoid pointless syscall churn on an unwritable disk. This
 * swallow-everything posture is sanctioned HERE only; application write
 * paths must surface their failures.
 *
 * Each mirrored chunk is prefixed with an ISO timestamp (the host adds its
 * own timestamps to stderr; the raw lines carry none). The stderr bytes the
 * host sees are untouched — the caller writes them separately.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Matches the desktop logger's retention window for `~/.ok/logs`. */
const MAX_AGE_DAYS = 7;
/** Aggregate cap across mirror files — matches the desktop logger's dir cap. */
const MAX_TOTAL_BYTES = 45 * 1024 * 1024;
/** Consecutive write failures before the mirror disables itself. */
const MAX_CONSECUTIVE_FAILURES = 5;

const MIRROR_FILE_PATTERN = /^mcp\.\d{4}-\d{2}-\d{2}\.log$/;

function defaultMcpLogsDir(): string {
  return join(homedir(), '.ok', 'logs');
}

/**
 * Retention sweep over the mirror's own files only (`mcp.<date>.log`) —
 * never the desktop's files in the same directory, which the desktop prunes
 * itself. Age pass first, then oldest-first deletion until the aggregate
 * size fits the cap. Fully best-effort.
 */
export function pruneMirrorLogs(logsDir: string, now: () => Date = () => new Date()): void {
  try {
    const nowMs = now().getTime();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(logsDir)
      .filter((f) => MIRROR_FILE_PATTERN.test(f))
      .flatMap((f) => {
        try {
          const stat = statSync(join(logsDir, f));
          return [{ name: f, mtime: stat.mtimeMs, size: stat.size }];
        } catch {
          return [];
        }
      });

    const remaining: { name: string; mtime: number; size: number }[] = [];
    for (const f of files) {
      if (nowMs - f.mtime > maxAgeMs) {
        try {
          unlinkSync(join(logsDir, f.name));
        } catch {
          // Already gone or unwritable — retention is advisory.
        }
      } else {
        remaining.push(f);
      }
    }

    remaining.sort((a, b) => a.mtime - b.mtime);
    let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);
    for (const f of remaining) {
      if (totalSize <= MAX_TOTAL_BYTES) break;
      try {
        unlinkSync(join(logsDir, f.name));
        totalSize -= f.size;
      } catch {
        // Same as above.
      }
    }
  } catch {
    // Missing dir / permission problem — nothing to prune.
  }
}

export interface McpStderrMirror {
  /** Append `chunk` (already newline-terminated by callers) to today's mirror file. */
  write: (chunk: string) => void;
}

export interface CreateMcpStderrMirrorOpts {
  /** Override the mirror directory (tests). Defaults to `~/.ok/logs`. */
  logsDir?: string;
  /** Clock override (tests). Drives both the filename date and retention. */
  now?: () => Date;
  /**
   * Delay before the startup retention sweep. Defaults to 5s (matching the
   * desktop logger's deferred prune); tests pass 0 to run it inline.
   */
  pruneDelayMs?: number;
}

export function createMcpStderrMirror(opts: CreateMcpStderrMirrorOpts = {}): McpStderrMirror {
  const logsDir = opts.logsDir ?? defaultMcpLogsDir();
  const now = opts.now ?? (() => new Date());
  const pruneDelayMs = opts.pruneDelayMs ?? 5000;

  if (pruneDelayMs <= 0) {
    pruneMirrorLogs(logsDir, now);
  } else {
    // unref so the pending sweep never keeps a shutting-down process alive.
    const timer = setTimeout(() => pruneMirrorLogs(logsDir, now), pruneDelayMs);
    timer.unref?.();
  }

  let consecutiveFailures = 0;
  let dirEnsured = false;
  return {
    write(chunk: string): void {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
      try {
        if (!dirEnsured) {
          mkdirSync(logsDir, { recursive: true });
          dirEnsured = true;
        }
        const timestamp = now().toISOString();
        // Date resolved per write, not at creation: the stdio process can
        // outlive its start date by days, and the date suffix IS the
        // rotation mechanism.
        const file = join(logsDir, `mcp.${timestamp.slice(0, 10)}.log`);
        appendFileSync(file, `${timestamp} ${chunk}`);
        consecutiveFailures = 0;
      } catch {
        // Re-ensure the dir on the next write: this is a process-lifetime
        // object (an MCP stdio session can run for days), so the logs dir can
        // be removed out from under it mid-session. Without clearing the flag
        // one external `rm -rf ~/.ok/logs` would permanently disable the
        // mirror after MAX_CONSECUTIVE_FAILURES even though a single mkdirSync
        // retry restores it — same recovery posture as the desktop logger.
        dirEnsured = false;
        consecutiveFailures++;
      }
    },
  };
}
