import { readFileSync, rmSync } from 'node:fs';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import { parseDocument } from 'yaml';
import { isOwnPiManagedFileEntry } from '../integrations/pi-extension.ts';
import { getTomlConfigEngine } from '../native/toml-config-engine.ts';
import { type EditorMcpTarget, isEntryUpToDate, isOwnManagedEntry } from './editors.ts';
import { classifyExistingMcpEntry, type McpDeclineReason, serverMapPath } from './init.ts';
import { existingFileMode, isCrlfDominant, surgicalJsonDelete } from './jsonc-surgical.ts';
import { type PiTrustRemoveAction, removePiTrustEntry } from './pi-acp-bridge.ts';

export type McpRemoveOutcome =
  | {
      kind: 'removed';
      trust?: PiTrustRemoveAction;
      trustError?: string;
    }
  | { kind: 'not-present' }
  | { kind: 'left-foreign' }
  | { kind: 'declined'; reason: McpDeclineReason };

function isRemovableOwnEntry(entry: unknown): boolean {
  return isEntryUpToDate(entry) || isOwnManagedEntry(entry) || isOwnPiManagedFileEntry(entry);
}

const JSON_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

export function removeOwnMcpEntry(
  target: EditorMcpTarget,
  cwd: string,
  home?: string,
  configPathOverride?: string,
): McpRemoveOutcome {
  const classified = classifyExistingMcpEntry(target, cwd, home, configPathOverride);
  if (classified.kind === 'absent' || classified.kind === 'no-entry') {
    return { kind: 'not-present' };
  }
  if (classified.kind === 'decline') {
    return { kind: 'declined', reason: classified.reason };
  }
  if (!isRemovableOwnEntry(classified.entry)) {
    return { kind: 'left-foreign' };
  }

  let configPath: string;
  try {
    configPath = configPathOverride ?? target.configPath(cwd, home);
  } catch {
    return { kind: 'not-present' };
  }
  const serverName = target.serverName(cwd);

  if (target.format === 'file') {
    rmSync(configPath, { force: true });
    const trust = removePiTrustEntry(cwd, home);
    return {
      kind: 'removed',
      trust: trust.action,
      ...(trust.error !== undefined ? { trustError: trust.error } : {}),
    };
  }

  if (target.format === 'toml') return removeTomlEntry(configPath, serverName);
  if (target.format === 'yaml') return removeYamlEntry(configPath, target.topLevelKey, serverName);
  return removeJsonEntry(configPath, target.topLevelKey, target.serverMapSubKey, serverName);
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
  } catch {
    return { kind: 'declined', reason: 'unparseable' };
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
  } catch {
    return { kind: 'declined', reason: 'unparseable' };
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
  } catch {
    return { kind: 'declined', reason: 'unparseable' };
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
