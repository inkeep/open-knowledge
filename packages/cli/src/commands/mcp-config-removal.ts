/**
 * Surgical removal of OK's own MCP entry from an editor config — the exact
 * mirror of `init.ts`'s `upsertJsonMcpConfig` / `upsertTomlMcpConfig` write
 * path, run in reverse for `ok uninstall` / `ok deinit`.
 *
 * OpenKnowledge is a guest in another tool's config: it owns exactly its one
 * `[topLevelKey][serverName]` entry and nothing else. Removal therefore:
 *   1. Reads + classifies via the never-throwing `classifyExistingMcpEntry`
 *      (shared with the write path — same oversize / duplicate-container /
 *      unparseable decline set, so a config OK can't safely edit is left
 *      byte-unchanged, never clobbered).
 *   2. Deletes ONLY when the present entry is recognizably OK's own managed
 *      entry — never a foreign server that merely shares the `open-knowledge`
 *      key (a squatting entry in a shared/cloned config, or a user's own fork).
 *   3. Edits the source text in place (jsonc-parser `modify` with `undefined`
 *      for JSON; the native `toml_edit` `removeEntry` for TOML) so every other
 *      token — sibling servers, comments, key order, indentation, a leading
 *      BOM, CRLF endings, trailing-newline state — is byte-preserved.
 *
 * TOML removal needs the format-preserving native engine (same constraint as
 * the TOML upsert): on the JS fallback a present config can only be rewritten
 * by the lossy whole-file serializer, so OK declines rather than degrade a
 * config it doesn't own.
 */

import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import { getTomlConfigEngine } from '../native/toml-config-engine.ts';
import { type EditorMcpTarget, isEntryUpToDate, isOwnManagedEntry } from './editors.ts';
import { classifyExistingMcpEntry, type McpDeclineReason, serverMapPath } from './init.ts';
import { existingFileMode, isCrlfDominant, surgicalJsonDelete } from './jsonc-surgical.ts';

/**
 * Outcome of a surgical MCP-entry removal.
 *
 * - `removed` — OK's own entry was present and stripped from the config.
 * - `not-present` — the config is absent/blank, or holds no entry under OK's
 *   server name. A clean no-op (the idempotent re-run case).
 * - `left-foreign` — an entry EXISTS under OK's server name but is NOT
 *   recognizably OK's managed entry (a customized/forked/squatting server).
 *   Left byte-unchanged and reported, never removed — same guest discipline the
 *   write path applies.
 * - `declined` — a present config OK cannot safely edit (unparseable, oversize,
 *   duplicate container, or the TOML fallback with no native writer). Left
 *   byte-unchanged.
 */
export type McpRemoveOutcome =
  | { kind: 'removed' }
  | { kind: 'not-present' }
  | { kind: 'left-foreign' }
  | { kind: 'declined'; reason: McpDeclineReason };

/**
 * True when `entry` is recognizably OK's OWN managed MCP entry — the only
 * shape removal will delete.
 *
 * `isEntryUpToDate` (the reclaim recognizer) is the primary gate: it matches
 * BOTH the chain shape (`{command:'/bin/sh', args:['-l','-c', <chain>]}` used by
 * claude / claude-desktop / cursor / codex) AND the OpenCode shape
 * (`{type:'local', enabled, command:['/bin/sh', …]}`), keyed on the
 * `# ok-mcp-v1` version sentinel embedded in the resolver chain. A foreign
 * server that merely shares the `open-knowledge` key lacks that sentinel and is
 * NOT matched, so it is preserved.
 *
 * `isOwnManagedEntry` (the exact canonical published match) is OR'd in for
 * completeness — it is a subset of `isEntryUpToDate` for the chain shape today,
 * but keeping it makes the "OK's own entry" intent explicit and independent of
 * the sentinel-substring heuristic. `isOwnManagedEntry` alone would be wrong
 * here: it never matches the OpenCode 3-key shape, so it would strand every
 * OpenCode entry.
 *
 * Deliberately does NOT recognize dev-mode (`node …/cli.mjs mcp`) or
 * version-stale (`# ok-mcp-v0`) entries — those lack a safe structural
 * signature that can't also match a foreign server, so they surface as
 * `left-foreign` (reported for manual removal) rather than risk deleting
 * someone else's config.
 */
function isRemovableOwnEntry(entry: unknown): boolean {
  return isEntryUpToDate(entry) || isOwnManagedEntry(entry);
}

/**
 * Largest JSON config we will rewrite in place — mirrors `init.ts`'s bound so a
 * history-bloated `~/.claude.json` (tens of MB) is declined rather than parsed
 * and re-emitted. `classifyExistingMcpEntry` already declines oversize via a
 * `stat`, so this is a defensive second gate on the raw read.
 */
const JSON_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Remove OK's own `[topLevelKey][serverName]` entry from a single editor's MCP
 * config, byte-preserving everything else. Every read/parse/classify failure
 * maps to a structured outcome (matching the write path, so one unreadable
 * config can't abort a whole uninstall). The one exception is the FINAL
 * `atomicWriteFileSync`: an I/O failure there (ENOSPC / EACCES on the dir)
 * propagates — the executor's per-op try/catch surfaces it as a `failed` op.
 *
 * `configPathOverride` targets a specific file (e.g. a project-scope
 * `.mcp.json`) instead of the target's default user-global path.
 */
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
  // `present`: an entry exists under OK's server name. Only delete it when it is
  // recognizably OK's own — a foreign/customized server is left untouched.
  if (!isRemovableOwnEntry(classified.entry)) {
    return { kind: 'left-foreign' };
  }

  let configPath: string;
  try {
    configPath = configPathOverride ?? target.configPath(cwd, home);
  } catch {
    // A platform-mismatched target (e.g. Claude Desktop on Linux) can't resolve
    // a path — nothing to remove.
    return { kind: 'not-present' };
  }
  const serverName = target.serverName(cwd);

  return target.format === 'toml'
    ? removeTomlEntry(configPath, serverName)
    : removeJsonEntry(configPath, target.topLevelKey, target.serverMapSubKey, serverName);
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

  // Nested-map editors (OpenClaw: `mcp.servers.<name>`) delete one level deeper;
  // `serverMapPath` mirrors the write path's flat-vs-nested branch so removal
  // targets the same node the upsert wrote.
  const { text, changed } = surgicalJsonDelete(raw, serverMapPath(topLevelKey, subKey, serverName));
  if (!changed) {
    // The classifier saw our entry but jsonc found nothing to remove — treat as
    // already-absent rather than write an identical file.
    return { kind: 'not-present' };
  }
  atomicWriteFileSync(configPath, text, { mode: existingFileMode(configPath) });
  return { kind: 'removed' };
}

function removeTomlEntry(configPath: string, serverName: string): McpRemoveOutcome {
  const engine = getTomlConfigEngine();
  if (engine.backend === 'fallback') {
    // No format-preserving writer available — a whole-file re-serialize would
    // strip comments and reflow the config. Decline rather than degrade a config
    // OK doesn't own (mirrors the TOML upsert's `no-native-writer` decline).
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

  // toml_edit strips a leading BOM, normalizes structural CRLF to LF, and always
  // emits a trailing newline; restore the source file's encoding so the only
  // byte-level change is the removal of OK's own entry.
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
