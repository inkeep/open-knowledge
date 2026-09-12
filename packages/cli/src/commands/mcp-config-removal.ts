import { readFileSync, rmSync } from 'node:fs';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import { parseDocument } from 'yaml';
import { isOwnPiManagedFileEntry } from '../integrations/pi-extension.ts';
import { getTomlConfigEngine } from '../native/toml-config-engine.ts';
import { configFileDeclineReason } from '../utils/config-file-error.ts';
import { type EditorMcpTarget, isEntryUpToDate, isOwnManagedEntry } from './editors.ts';
import { classifyExistingMcpEntry, type McpConfigDeclineReason, serverMapPath } from './init.ts';
import { existingFileMode, isCrlfDominant, surgicalJsonDelete } from './jsonc-surgical.ts';
import { type PiTrustRemoveAction, removePiTrustEntry } from './pi-acp-bridge.ts';
import { resolveRemovalFilePath } from './removal-file-path.ts';

type McpTrustRemoval =
  | {
      trust?: Extract<PiTrustRemoveAction, 'removed' | 'not-present'>;
      trustDetail?: never;
    }
  | {
      trust: Extract<PiTrustRemoveAction, 'kept-shared' | 'kept-unowned'>;
      trustDetail: string;
    };

export type McpRemoveOutcome =
  | ({ kind: 'removed' } & McpTrustRemoval)
  | { kind: 'not-present' }
  | { kind: 'left-foreign' }
  | { kind: 'declined'; reason: McpConfigDeclineReason };

function isRemovableOwnEntry(entry: unknown): boolean {
  return isEntryUpToDate(entry) || isOwnManagedEntry(entry) || isOwnPiManagedFileEntry(entry);
}

const JSON_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

function cleanupPiTrust(
  cwd: string,
  home: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  recordedOnly = false,
): McpTrustRemoval {
  const trust = removePiTrustEntry(cwd, home, env, { recordedOnly });
  switch (trust.action) {
    case 'removed':
    case 'not-present':
      return { trust: trust.action };
    case 'kept-shared':
    case 'kept-unowned':
      return { trust: trust.action, trustDetail: trust.detail };
    case 'failed':
    case 'refused-unreadable':
    case 'kept-unverified': {
      const retained = recordedOnly
        ? 'Trust cleanup remains incomplete'
        : 'The bridge file was left untouched';
      throw new Error(
        `Pi trust cleanup failed (${trust.action}):\n${trust.error}\n${retained} so cleanup can be retried.`,
      );
    }
    default: {
      const exhaustive: never = trust;
      throw new Error(`unhandled Pi trust cleanup result: ${exhaustive}`);
    }
  }
}

function cleanupAbsentPiBridge(
  target: EditorMcpTarget,
  cwd: string,
  home: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): McpRemoveOutcome {
  if (target.id !== 'pi') return { kind: 'not-present' };
  const trust = cleanupPiTrust(cwd, home, env, true);
  return trust.trust === 'not-present' ? { kind: 'not-present' } : { kind: 'removed', ...trust };
}

export function removeOwnMcpEntry(
  target: EditorMcpTarget,
  cwd: string,
  home?: string,
  configPathOverride?: string,
  env?: NodeJS.ProcessEnv,
): McpRemoveOutcome {
  let configPath: string;
  try {
    configPath = configPathOverride ?? target.configPath(cwd, home);
  } catch {
    return { kind: 'not-present' };
  }
  const resolved = resolveRemovalFilePath(configPath);
  if (resolved.kind === 'not-present') return cleanupAbsentPiBridge(target, cwd, home, env);
  if (resolved.kind === 'declined') return resolved;

  const classified = classifyExistingMcpEntry(target, cwd, home, resolved.path);
  if (classified.kind === 'absent' || classified.kind === 'no-entry') {
    return cleanupAbsentPiBridge(target, cwd, home, env);
  }
  if (classified.kind === 'decline') {
    return { kind: 'declined', reason: classified.reason };
  }
  if (!isRemovableOwnEntry(classified.entry)) {
    return { kind: 'left-foreign' };
  }

  const serverName = target.serverName(cwd);

  if (target.format === 'file') {
    const trust = cleanupPiTrust(cwd, home, env);
    try {
      rmSync(configPath, { force: true });
    } catch (error) {
      if (!trust.trustDetail) throw error;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${trust.trustDetail}`,
        {
          cause: error,
        },
      );
    }
    return {
      kind: 'removed',
      ...trust,
    };
  }

  if (target.format === 'toml') return removeTomlEntry(resolved.path, serverName);
  if (target.format === 'yaml')
    return removeYamlEntry(resolved.path, target.topLevelKey, serverName);
  return removeJsonEntry(resolved.path, target.topLevelKey, target.serverMapSubKey, serverName);
}

function removeJsonEntry(
  configPath: string,
  topLevelKey: string,
  subKey: string | undefined,
  serverName: string,
): McpRemoveOutcome {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    return { kind: 'declined', reason: configFileDeclineReason(error) };
  }
  if (Buffer.byteLength(raw, 'utf-8') > JSON_CONFIG_MAX_BYTES) {
    return { kind: 'declined', reason: 'oversize' };
  }

  const { text, changed } = surgicalJsonDelete(raw, serverMapPath(topLevelKey, subKey, serverName));
  if (!changed) {
    return { kind: 'not-present' };
  }
  atomicWriteFileSync(configPath, text, { mode: existingFileMode(configPath) });
  return { kind: 'removed' };
}

function removeYamlEntry(
  configPath: string,
  topLevelKey: string,
  serverName: string,
): McpRemoveOutcome {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    return { kind: 'declined', reason: configFileDeclineReason(error) };
  }
  if (Buffer.byteLength(raw, 'utf-8') > JSON_CONFIG_MAX_BYTES) {
    return { kind: 'declined', reason: 'oversize' };
  }

  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const doc = parseDocument(body);
  if (doc.errors.length > 0) {
    return { kind: 'declined', reason: 'unparseable' };
  }

  const path = [topLevelKey, serverName];
  if (!doc.hasIn(path)) {
    return { kind: 'not-present' };
  }
  doc.deleteIn(path);

  let text = doc.toString();
  const crlfDominant = isCrlfDominant(body);
  const wantTrailingNewline = body.trim() === '' || body.endsWith('\n');
  if (wantTrailingNewline) {
    if (!text.endsWith('\n')) text = `${text}\n`;
  } else {
    text = text.replace(/\n+$/, '');
  }
  if (crlfDominant) {
    text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }
  const newText = `${hasBom ? '\uFEFF' : ''}${text}`;
  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: 'removed' };
}

function removeTomlEntry(configPath: string, serverName: string): McpRemoveOutcome {
  const engine = getTomlConfigEngine();
  if (engine.backend === 'fallback') {
    return { kind: 'declined', reason: 'no-native-writer' };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    return { kind: 'declined', reason: configFileDeclineReason(error) };
  }

  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const crlfDominant = isCrlfDominant(body);
  const wantTrailingNewline = body.trim() === '' || body.endsWith('\n');

  let result: { text: string; existed: boolean };
  try {
    result = engine.removeEntry(body, serverName);
  } catch {
    return { kind: 'declined', reason: 'unparseable' };
  }
  if (!result.existed) {
    return { kind: 'not-present' };
  }

  let text = result.text;
  if (wantTrailingNewline) {
    if (!text.endsWith('\n')) text = `${text}\n`;
  } else {
    text = text.replace(/\n+$/, '');
  }
  if (crlfDominant) {
    text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }
  const newText = `${hasBom ? '\uFEFF' : ''}${text}`;
  if (newText !== raw) {
    atomicWriteFileSync(configPath, newText, { mode: existingFileMode(configPath) });
  }
  return { kind: 'removed' };
}
