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

const PI_TRUST_FILENAME = 'trust.json';

export type PiBridgeFileState = 'absent' | 'own-current' | 'own-stale' | 'foreign' | 'unreadable';

export type PiTrustState = 'trusted' | 'untrusted' | 'unreadable';

export interface PiBridgeState {
  cwd: string;
  bridgePath: string;
  trustPath: string;
  bridge: PiBridgeFileState;
  trust: PiTrustState;
  bridgeLoadable: boolean;
  otherExtensions: readonly string[];
}

export type { PiBridgeWriteAction, PiTrustWriteAction };

export type PiTrustRemoveAction =
  | 'removed'
  | 'not-present'
  | 'kept-shared'
  | 'kept-unverified'
  | 'refused-unreadable'
  | 'failed';

export interface EnsurePiBridgeResult {
  ok: boolean;
  cwd: string;
  bridgePath: string;
  trustPath: string;
  bridge: PiBridgeWriteAction;
  trust: PiTrustWriteAction;
  error?: string;
}

function resolvePiPaths(
  cwd: string,
  home?: string,
): {
  cwd: string;
  bridgePath: string;
  trustPath: string;
} {
  const normalizedCwd = resolve(cwd);
  const agentDir =
    home === undefined ? resolvePiAgentDirPath() : resolvePiAgentDirPath({ home, env: {} });
  return {
    cwd: normalizedCwd,
    bridgePath: EDITOR_TARGETS.pi.projectConfigPath?.(normalizedCwd) ?? '',
    trustPath: join(agentDir, PI_TRUST_FILENAME),
  };
}

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
