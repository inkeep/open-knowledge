/**
 * Pi ACP-thread bridge primitives — probe + provision the two machine-local
 * facts a Pi agent needs before it can see Open Knowledge's tools.
 *
 * Pi has no MCP client at all: the ACP adapter accepts an `mcpServers` array
 * and silently drops it, so an OK thread against Pi is toolless unless OK's
 * bridge extension is on disk. Pi loads project extensions from
 * `<cwd>/.pi/extensions/*.ts` ONLY when the cwd is trusted — `~/.pi/agent/
 * trust.json` is a flat `path -> true` map, and trust is FOLDER-scoped: one
 * entry enables every extension in that folder, not just OK's. Both halves are
 * required; either alone leaves the thread without tools.
 *
 * Two functions, deliberately split: {@link probePiBridgeState} is a pure read
 * (safe to call before asking the user for anything) and
 * {@link ensurePiBridge} is the write half. Both are structured-result-only —
 * neither throws, including on a corrupt or unreadable `trust.json`, because
 * the caller is a thread-launch path that must stay alive and report rather
 * than abort the thread.
 *
 * Write posture mirrors OK's guest-in-someone-else's-config discipline: the
 * bridge file is written through the same production writer `ok init` uses
 * (`writeEditorMcpConfig` at project scope — advisory lock, atomic write,
 * byte-equality skip), a foreign or unreadable file at OK's managed path is
 * REFUSED rather than overwritten, and the trust write is skipped entirely
 * unless the bridge is OK's own — flipping Pi's folder-trust gate for a
 * folder whose `.pi/extensions` contents we did not verify or write would
 * enable code we never inspected.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  PiBridgeWriteAction,
  PiTrustWriteAction,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import {
  atomicWriteFileSync,
  withFileLock,
  withFileLockSync,
} from '@inkeep/open-knowledge-core/server';
import { buildPiExtensionSource, isOwnPiManagedFileEntry } from '../integrations/pi-extension.ts';
import { isObject } from '../utils/is-object.ts';
import {
  EDITOR_TARGETS,
  isEntryUpToDate,
  type McpInstallOptions,
  resolvePiAgentDirPath,
} from './editors.ts';
import { classifyExistingMcpEntry, writeEditorMcpConfig } from './init.ts';
import { existingFileMode } from './jsonc-surgical.ts';

/** Filename of Pi's folder-trust store inside its agent home. */
const PI_TRUST_FILENAME = 'trust.json';

/**
 * State of the managed bridge file at `<cwd>/.pi/extensions/open-knowledge.ts`.
 *
 * `own-stale` covers both an older published version and a dev-mode drop —
 * everything OK recognizes as its own but would rewrite. `foreign` is a file
 * OK did not write; `unreadable` is a present file OK could not inspect
 * (oversize, unreadable bytes). Both are refusal states, never overwrite
 * targets.
 */
export type PiBridgeFileState = 'absent' | 'own-current' | 'own-stale' | 'foreign' | 'unreadable';

/**
 * Whether Pi will load project extensions for this cwd. `unreadable` means
 * `trust.json` exists but is corrupt or not a JSON object — OK can neither
 * confirm trust nor safely rewrite the file.
 */
export type PiTrustState = 'trusted' | 'untrusted' | 'unreadable';

export interface PiBridgeState {
  /** Absolute, normalized cwd — the exact key used in Pi's trust store. */
  cwd: string;
  /** Absolute path of OK's managed Pi bridge extension for this project. */
  bridgePath: string;
  /** Absolute path of Pi's folder-trust store. */
  trustPath: string;
  bridge: PiBridgeFileState;
  trust: PiTrustState;
  /**
   * True when Pi would load OK's bridge for this cwd as things stand: an
   * own-* bridge file (a stale one still registers OK's tools) in a trusted
   * folder. Deliberately narrower than "nothing to do" — a stale bridge is
   * loadable AND worth refreshing.
   */
  bridgeLoadable: boolean;
  /**
   * Extension filenames already in `<cwd>/.pi/extensions/` that OK did not
   * write, so a consent prompt can name what else trusting this folder turns
   * on. Trust is folder-scoped, and "approve" reads very differently against
   * an empty folder than against one already holding somebody else's code.
   * Empty when the folder is absent or unreadable — absence of evidence, so
   * callers must not present it as "nothing else here".
   */
  otherExtensions: readonly string[];
}

/**
 * What {@link ensurePiBridge} did to each half. Re-exported from core rather
 * than redeclared: these travel to the client on the thread wire, so core owns
 * them and a member added there has to reach this surface, not be silently
 * absorbed by a structurally-identical local copy.
 */
export type { PiBridgeWriteAction, PiTrustWriteAction };

/**
 * What {@link removePiTrustEntry} did. `kept-shared` is the deliberate no-op:
 * another extension still lives in the folder, and the trust entry that keeps
 * it loading is not OK's to revoke on the way out.
 */
export type PiTrustRemoveAction =
  | 'removed'
  | 'not-present'
  | 'kept-shared'
  /**
   * Kept because OK could not read the extensions folder to find out whether
   * anything else depends on the grant. Distinct from `kept-shared`: that one
   * is a verified "yes, something needs it", this one is "unknown" — and an
   * inconclusive check has to take the conservative branch.
   */
  | 'kept-unverified'
  | 'refused-unreadable'
  | 'failed';

export interface EnsurePiBridgeResult {
  /** True only when BOTH halves hold: bridge is OK's own and cwd is trusted. */
  ok: boolean;
  cwd: string;
  bridgePath: string;
  trustPath: string;
  bridge: PiBridgeWriteAction;
  trust: PiTrustWriteAction;
  /** Present on the `failed` and `refused-unreadable` outcomes only. */
  error?: string;
}

/** Resolve the pair of paths both halves key off, from one normalized cwd. */
function resolvePiPaths(
  cwd: string,
  home?: string,
): {
  cwd: string;
  bridgePath: string;
  trustPath: string;
} {
  const normalizedCwd = resolve(cwd);
  // An injected `home` must win over `PI_CODING_AGENT_DIR`: the resolver
  // prefers that env var, so a machine that sets it would silently redirect a
  // home-scoped caller (tests, a sandboxed probe) onto the real agent dir.
  // Production callers pass no `home`, so the env override stays honored.
  const agentDir =
    home === undefined ? resolvePiAgentDirPath() : resolvePiAgentDirPath({ home, env: {} });
  return {
    cwd: normalizedCwd,
    // Pi's registry entry always declares a project path — the bridge file IS
    // its project config — so the fallback is unreachable; reading the path
    // from the registry keeps a future relocation in one place.
    bridgePath: EDITOR_TARGETS.pi.projectConfigPath?.(normalizedCwd) ?? '',
    trustPath: join(agentDir, PI_TRUST_FILENAME),
  };
}

/**
 * Classify the bridge file through the same classifier the repair/reclaim
 * sweeps use, so a blank file reads as creatable (`absent`) and an
 * oversize/unreadable one reads as a refusal rather than as foreign bytes.
 * Returns the raw source alongside, which the ensure path diffs against the
 * freshly built source to tell "already byte-current" from "needs a refresh".
 */
function classifyPiBridgeFile(
  cwd: string,
  bridgePath: string,
  home: string | undefined,
): { state: PiBridgeFileState; text: string | null } {
  const classified = classifyExistingMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePath);
  if (classified.kind === 'absent') return { state: 'absent', text: null };
  if (classified.kind !== 'present') return { state: 'unreadable', text: null };
  const entry = classified.entry;
  const text =
    Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? entry.args[0] : null;
  if (isEntryUpToDate(entry)) return { state: 'own-current', text };
  if (isOwnPiManagedFileEntry(entry)) return { state: 'own-stale', text };
  return { state: 'foreign', text };
}

/**
 * Read Pi's trust store. An absent or blank file is `untrusted` with an empty
 * map (safe to create into); a present file OK cannot parse into a JSON object
 * is `unreadable` with no map, which stops the write path.
 */
function readPiTrust(
  trustPath: string,
  cwd: string,
): { state: PiTrustState; entries: Record<string, unknown> | null; trailingNewline: boolean } {
  let raw: string;
  try {
    raw = readFileSync(trustPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'untrusted', entries: {}, trailingNewline: false };
    }
    return { state: 'unreadable', entries: null, trailingNewline: false };
  }
  if (raw.trim() === '') return { state: 'untrusted', entries: {}, trailingNewline: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', entries: null, trailingNewline: false };
  }
  if (!isObject(parsed)) return { state: 'unreadable', entries: null, trailingNewline: false };
  return {
    state: parsed[cwd] === true ? 'trusted' : 'untrusted',
    entries: parsed,
    trailingNewline: raw.endsWith('\n'),
  };
}

/**
 * Read-only report of both halves of the Pi bridge for `cwd`. Never throws;
 * every unreadable surface resolves to its own state so a caller can tell
 * "not provisioned" from "cannot inspect".
 *
 * `home` overrides the user home used to locate Pi's agent dir (test hook).
 */
export function probePiBridgeState(cwd: string, home?: string): PiBridgeState {
  const paths = resolvePiPaths(cwd, home);
  const bridge = classifyPiBridgeFile(paths.cwd, paths.bridgePath, home).state;
  const trust = readPiTrust(paths.trustPath, paths.cwd).state;
  return {
    ...paths,
    bridge,
    trust,
    bridgeLoadable: (bridge === 'own-current' || bridge === 'own-stale') && trust === 'trusted',
    otherExtensions: listOtherPiExtensions(paths.bridgePath).names,
  };
}

/**
 * Extension files beside OK's managed one — sorted, so the same folder always
 * reads back the same way. Pi loads `.ts` modules from this directory.
 *
 * `verified` separates "there are none" from "OK could not look", which an
 * empty list alone cannot: one caller merely displays the names, but the other
 * gates a revocation on them, and a directory OK cannot read must not be
 * mistaken for one it read and found empty. A directory that does not exist IS
 * verified empty — there is nothing there to depend on the trust grant.
 */
function listOtherPiExtensions(bridgePath: string): {
  names: readonly string[];
  verified: boolean;
} {
  const dir = dirname(bridgePath);
  const own = basename(bridgePath);
  try {
    return {
      names: readdirSync(dir)
        .filter((name) => name !== own && name.endsWith('.ts'))
        .sort(),
      verified: true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { names: [], verified: code === 'ENOENT' || code === 'ENOTDIR' };
  }
}

/**
 * Idempotently provision both halves: drop (or refresh) OK's managed bridge
 * extension for `cwd`, then add `cwd -> true` to Pi's trust store.
 *
 * Ordering is load-bearing — the trust write only runs once the bridge file is
 * OK's own, because trusting the folder enables EVERY extension in it. A
 * foreign or unreadable file at the managed path stops the whole call with a
 * structured refusal; it is never overwritten.
 *
 * `options` defaults to the published launcher shape that `ok init` writes;
 * pass `{ mode: 'dev' }` to match a dev-server install. The generated source
 * is byte-deterministic per `options`, so a re-run with the same value is a
 * no-op on disk.
 */
export async function ensurePiBridge(
  cwd: string,
  options: McpInstallOptions = { mode: 'published' },
  home?: string,
): Promise<EnsurePiBridgeResult> {
  const base = resolvePiPaths(cwd, home);
  const existing = classifyPiBridgeFile(base.cwd, base.bridgePath, home);

  if (existing.state === 'foreign') {
    return { ...base, ok: false, bridge: 'refused-foreign', trust: 'skipped' };
  }
  if (existing.state === 'unreadable') {
    return { ...base, ok: false, bridge: 'refused-unreadable', trust: 'skipped' };
  }

  let bridge: PiBridgeWriteAction;
  if (existing.state === 'absent') {
    bridge = 'written';
  } else {
    // Own file: the version sentinel alone can't answer "already correct" —
    // a current published drop is stale against `{ mode: 'dev' }` and vice
    // versa — so diff against the bytes the writer would produce. The builder
    // throws for a dev install whose launcher path can't be inferred; fall
    // through to the writer, which turns that same throw into a structured
    // failure instead of one escaping this never-throws surface.
    let desired: string | undefined;
    try {
      desired = buildPiExtensionSource(options);
    } catch {
      desired = undefined;
    }
    bridge = desired !== undefined && existing.text === desired ? 'unchanged' : 'refreshed';
  }

  if (bridge !== 'unchanged') {
    const result = writeEditorMcpConfig(
      EDITOR_TARGETS.pi,
      base.cwd,
      options,
      home,
      base.bridgePath,
    );
    if (result.action !== 'written' && result.action !== 'overwritten') {
      return {
        ...base,
        ok: false,
        bridge: 'failed',
        trust: 'skipped',
        error: result.error ?? `bridge write ${result.action}`,
      };
    }
  }

  const trust = await addPiTrustEntry(base.trustPath, base.cwd);
  return {
    ...base,
    ok: trust.action === 'already-trusted' || trust.action === 'added',
    bridge,
    trust: trust.action,
    ...(trust.error !== undefined ? { error: trust.error } : {}),
  };
}

/**
 * Add `cwd -> true` to Pi's flat trust map, preserving every existing entry,
 * the file's key order, its trailing-newline convention, and its mode. Creates
 * the file and its parent dirs when absent. A file OK cannot parse is left
 * byte-untouched: Pi's own security store is not ours to reset.
 *
 * Re-reads under the advisory lock — Pi itself (or a second OK process) may
 * have written between the probe and the write.
 *
 * Async on purpose: the ACP thread manager calls this from the long-running
 * collaboration server, and the sync lock's contention path BUSY-WAITS, which
 * would stall the event loop for every connected client, not just the thread
 * doing the approving. The await-able lock has identical semantics and sleeps
 * instead. {@link removePiTrustEntry} keeps the sync one — its callers are
 * short-lived CLI invocations with nothing else on the loop.
 */
async function addPiTrustEntry(
  trustPath: string,
  cwd: string,
): Promise<{ action: PiTrustWriteAction; error?: string }> {
  try {
    mkdirSync(dirname(trustPath), { recursive: true });
  } catch (err) {
    return { action: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  const captured: { action: PiTrustWriteAction } = { action: 'added' };
  try {
    await withFileLock(`${trustPath}.lock`, async () => {
      const current = readPiTrust(trustPath, cwd);
      if (current.state === 'trusted') {
        captured.action = 'already-trusted';
        return;
      }
      if (current.entries === null) {
        captured.action = 'refused-unreadable';
        return;
      }
      // Spread-then-set keeps an existing key in its original position (a
      // `false` entry flips in place) and appends a new one at the end; Pi
      // reads the map by key, not by order.
      const next = { ...current.entries, [cwd]: true };
      const serialized = JSON.stringify(next, null, 2) + (current.trailingNewline ? '\n' : '');
      const mode = existingFileMode(trustPath);
      atomicWriteFileSync(trustPath, serialized, mode !== undefined ? { mode } : undefined);
      captured.action = 'added';
    });
  } catch (err) {
    return { action: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  return captured.action === 'refused-unreadable'
    ? { action: 'refused-unreadable', error: 'trust store is not a readable JSON object' }
    : { action: captured.action };
}

/**
 * Drop `cwd` from Pi's trust map — the revocation half of
 * {@link ensurePiBridge}, run when OK's managed bridge is removed
 * (`ok deinit` / `ok uninstall`).
 *
 * Removal is CONDITIONAL on the folder holding no other extension: the trust
 * entry is folder-scoped, so if somebody else's extension is still there,
 * revoking would silently break it. In that case the entry stays and the
 * outcome says so — as it does when the folder could not be read at all, since
 * an inconclusive check is not a licence to revoke.
 *
 * Known limitation: OK never persisted who added the entry, so a folder the
 * user trusted themselves before OK ever wrote one is indistinguishable from
 * one OK added — and OK's removal takes it away. The narrow condition above
 * keeps the blast radius to "a folder whose only extension was OK's".
 *
 * Sync, unlike the add half: every caller is a short-lived CLI invocation with
 * nothing else on the event loop. Never throws; a trust store OK cannot parse
 * is left byte-untouched.
 */
export function removePiTrustEntry(
  cwd: string,
  home?: string,
): { action: PiTrustRemoveAction; error?: string } {
  const base = resolvePiPaths(cwd, home);
  const others = listOtherPiExtensions(base.bridgePath);
  if (!others.verified) {
    return { action: 'kept-unverified', error: 'could not read the Pi extensions folder' };
  }
  if (others.names.length > 0) return { action: 'kept-shared' };
  // Nothing to remove and no lock to take. The add half creates the parent dir
  // on its way to writing; removal must not, or the "there was never a store"
  // case fails on a lock file it had no business creating.
  if (!existsSync(base.trustPath)) return { action: 'not-present' };
  const captured: { action: PiTrustRemoveAction } = { action: 'removed' };
  try {
    withFileLockSync(`${base.trustPath}.lock`, () => {
      const current = readPiTrust(base.trustPath, base.cwd);
      if (current.entries === null) {
        captured.action = current.state === 'unreadable' ? 'refused-unreadable' : 'not-present';
        return;
      }
      if (!(base.cwd in current.entries)) {
        captured.action = 'not-present';
        return;
      }
      const next = { ...current.entries };
      delete next[base.cwd];
      const serialized = JSON.stringify(next, null, 2) + (current.trailingNewline ? '\n' : '');
      const mode = existingFileMode(base.trustPath);
      atomicWriteFileSync(base.trustPath, serialized, mode !== undefined ? { mode } : undefined);
      captured.action = 'removed';
    });
  } catch (err) {
    return { action: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  return captured.action === 'refused-unreadable'
    ? { action: 'refused-unreadable', error: 'trust store is not a readable JSON object' }
    : { action: captured.action };
}
