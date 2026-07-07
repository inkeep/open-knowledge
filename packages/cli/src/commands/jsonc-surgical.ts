/**
 * Byte-preserving surgical deletion inside a JSON/JSONC document — the shared
 * primitive behind OK's config REMOVAL paths (MCP-entry removal + launch.json
 * entry removal for `ok uninstall` / `ok deinit`).
 *
 * OpenKnowledge is a guest in every config it touches: it owns one node and
 * must leave every other token — sibling entries, comments, key order,
 * indentation, a leading BOM, CRLF endings — byte-identical. jsonc-parser's
 * `modify(text, path, undefined, …)` deletes exactly one node and reflows only
 * the region around it, which is the one edit primitive that meets that bar
 * (re-serializing the parsed value would strip comments + reflow the whole
 * file).
 *
 * Mirror of the formatting helpers in `init.ts`'s UPSERT path (`detectJsonIndent`
 * / `existingFileMode`); they run on independent invocations, so a drift can
 * only make a remove reflow slightly unlike an upsert, never corrupt a document.
 */

import { statSync } from 'node:fs';
import { applyEdits as applyJsoncEdits, modify as modifyJsonc } from 'jsonc-parser';

/**
 * Detect the indentation a JSON/JSONC file already uses so a surgical edit
 * reflows adjacent siblings to the file's own convention. jsonc-parser formats
 * only the edited region from the passed options and does NOT auto-detect.
 */
function detectJsonIndent(body: string): { insertSpaces: boolean; tabSize: number } {
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.length === line.length) continue;
    if (line.charCodeAt(0) === 0x09) return { insertSpaces: false, tabSize: 1 };
    return { insertSpaces: true, tabSize: line.length - trimmed.length };
  }
  return { insertSpaces: true, tabSize: 2 };
}

/**
 * True when the text's dominant line ending is CRLF (at least as many `\r\n` as
 * bare `\n`; ties resolve to CRLF). Used to re-apply a TOML file's CRLF
 * convention after toml_edit normalizes it to LF. Shared by the TOML upsert
 * (init) and removal paths so the two can't drift.
 */
export function isCrlfDominant(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return false;
  const bareLf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf;
}

/**
 * The existing file's permission bits, or `undefined` when it can't be stat'd.
 * Preserved on an in-place rewrite so a config a user tightened (`chmod 600`) is
 * never silently widened.
 */
export function existingFileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Delete the node at `path` from JSON/JSONC `raw`, byte-preserving everything
 * else. Pure — the caller owns read + write (so it can choose to delete the
 * whole file instead when the last owned node is gone). Returns the new text
 * and whether it actually changed (`changed: false` when `path` matched nothing,
 * e.g. an already-absent node).
 *
 * A leading BOM is stripped for the edit (so node offsets stay clean) and
 * re-applied; the file's dominant EOL is passed through to the formatter.
 */
export function surgicalJsonDelete(
  raw: string,
  path: (string | number)[],
): { text: string; changed: boolean } {
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const edits = modifyJsonc(body, path, undefined, {
    formattingOptions: { ...detectJsonIndent(body), eol },
  });
  if (edits.length === 0) return { text: raw, changed: false };
  const text = `${hasBom ? '\uFEFF' : ''}${applyJsoncEdits(body, edits)}`;
  return { text, changed: text !== raw };
}
