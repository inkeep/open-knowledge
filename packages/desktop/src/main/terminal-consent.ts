/**
 * Main-side trust-boundary backstop for the docked terminal.
 *
 * The renderer's `TerminalGate` is the UX-facing gate (it mounts the
 * PTY-spawning panel unless the project has opted out), but the shell is the
 * largest capability in the app and is RCE-class — so main re-checks before
 * forking a real shell rather than trusting a single React component. A renderer
 * regression, a future `terminalManager.create` caller, or a renderer compromise
 * still cannot spawn a shell against a project that explicitly opted out.
 *
 * Posture: fail-OPEN. OK Desktop is a local-first app the user installed and
 * launched themselves; the embedded shell runs at the same privilege as the app
 * process they already trust. So the terminal is allowed by default and this
 * backstop refuses only on an explicit `terminal.enabled === false` opt-out — an
 * absent, unreadable, or malformed config reads as allowed, never refused.
 *
 * `terminal.enabled` is `scope: project-local`, so only the project-local layer
 * (`<projectDir>/.ok/local/config.yml`, gitignored) is authoritative — the same
 * file the renderer's opt-out writer (`use-terminal-enabled`) patches. We read
 * the raw YAML (not the schema-defaulted merge) so the opt-out is read straight
 * off disk, never inferred from a default.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * False only when the project-local config explicitly sets
 * `terminal.enabled: false`. A missing file, unreadable file, malformed YAML, an
 * absent leaf, `null`, or `true` all read as allowed — only the explicit opt-out
 * refuses the shell.
 */
export function isTerminalConsented(projectDir: string): boolean {
  const path = resolveConfigPath('project-local', projectDir);
  if (!existsSync(path)) return true;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'));
  } catch (err) {
    // I/O or YAML parse error on an existing file — fail open per the module's
    // default-on posture. Log it so a filesystem anomaly (permission denied,
    // truncation, lock) is distinguishable from the intended absent-config case
    // when debugging a consent-gate bypass; the refusal path logs symmetrically
    // at the IPC caller.
    getLogger('terminal-consent').warn({ err }, 'config read/parse failed; failing open');
    return true;
  }
  if (!isObject(parsed)) return true;
  const terminal = parsed.terminal;
  if (!isObject(terminal)) return true;
  return terminal.enabled !== false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default grace budget for {@link isTerminalConsentedWithGrace}.
 *
 * MUST stay strictly above the server's 2000ms `onStoreDocument` store debounce
 * (`debounce=2000` in server-factory; the desktop boots the server without
 * overriding it) — otherwise a just-lifted opt-out's disk write can never land
 * inside the window and the terminal refuses until the project is reopened. The
 * 1000ms headroom absorbs the WS round-trip + fs latency on top of the debounce.
 */
export const TERMINAL_CONSENT_GRACE_TIMEOUT_MS = 3000;

/**
 * Debounce-tolerant re-read for the opt-out → re-enable transition.
 *
 * Under the fail-open posture the synchronous check refuses only an explicit
 * `false`, so this fallback matters in exactly one case: a project that was
 * opted out and is being re-enabled. The renderer lifts the opt-out through a
 * live CRDT config binding (in-memory) and immediately mounts the shell, but the
 * new value only reaches `<projectDir>/.ok/local/config.yml` after the server's
 * persistence debounce — Hocuspocus's `onStoreDocument` L1 store, configured at
 * 2000ms (`debounce=2000` in server-factory; the desktop boots the server
 * without overriding it). A single toggle is one isolated Y.Text change, so it
 * flushes at exactly that 2000ms — it never extends toward `maxDebounce`, which
 * only applies under a continuous edit burst. A shell-open issued in that window
 * reads the file before the write lands, so the synchronous
 * {@link isTerminalConsented} still sees the stale `false` and refuses even
 * though the opt-out was just lifted.
 *
 * This polls the same raw disk file (never trusting the renderer; no CRDT or
 * persistence-layer coupling) and resolves `true` the moment a read no longer
 * shows the explicit `false`. If the window elapses still reading `false` it
 * resolves `false`, so a project that stays opted out keeps refusing. Callers
 * use this only as a fallback after the synchronous check fails, so the common
 * allowed path stays instant and only a just-re-enabled open waits briefly.
 *
 * The default `timeoutMs` MUST exceed the 2000ms store debounce or a
 * just-re-enabled open can never observe the write and refuses until the project
 * is reopened (the disk file is only correct on next launch). The poll returns
 * as soon as the write lands — typically ~2000ms after the toggle — so the cap
 * is a safety ceiling, not the expected wait; 3000ms keeps margin above the
 * debounce.
 */
export async function isTerminalConsentedWithGrace(
  projectDir: string,
  {
    timeoutMs = TERMINAL_CONSENT_GRACE_TIMEOUT_MS,
    intervalMs = 50,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Re-check immediately first (covers the case where the write landed between
  // the caller's synchronous check and this call), then poll until the window
  // closes.
  while (true) {
    if (isTerminalConsented(projectDir)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
