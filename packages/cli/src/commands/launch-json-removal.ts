/**
 * Surgical removal of OK's own `.claude/launch.json` entry for `ok deinit`.
 *
 * `.claude/launch.json` is a SHARED file: OK owns exactly one entry in the
 * `configurations[]` array — the one named `LAUNCH_CONFIG_NAME`
 * (`open-knowledge-ui`) — and Claude Code / the user may keep others alongside
 * it (`repair-launch-json.ts` preserves them). So deinit must NOT delete the
 * whole file; it surgically removes only OK's array element, byte-preserving
 * every other configuration, comment, and formatting token.
 *
 * The one case the whole file IS removed: when OK's entry was the ONLY
 * configuration — the file was scaffolded by `ok init` and holds nothing else
 * of the user's — so deleting it is the clean full reversal (a later `ok init`
 * re-scaffolds it), matching how the fish PATH conf file is deleted when
 * stripping OK's block leaves it empty.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import {
  getNodeValue,
  type Node as JsoncNode,
  type ParseError as JsoncParseError,
  parseTree,
} from 'jsonc-parser';
import { isObject } from '../utils/is-object.ts';
import { LAUNCH_CONFIG_NAME } from './init.ts';
import { existingFileMode, surgicalJsonDelete } from './jsonc-surgical.ts';

export type LaunchRemoveOutcome =
  | { kind: 'removed' }
  | { kind: 'removed-file' }
  | { kind: 'not-present' }
  | { kind: 'declined' };

const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

// jsonc-parser reports a leading UTF-8 BOM as a lone InvalidSymbol (code 1) at
// offset 0 while still parsing the rest — the one benign "error" we tolerate.
const JSONC_INVALID_SYMBOL_CODE = 1;
function isBenignBomError(error: JsoncParseError, raw: string): boolean {
  return (
    error.error === JSONC_INVALID_SYMBOL_CODE && error.offset === 0 && raw.charCodeAt(0) === 0xfeff
  );
}

/**
 * Remove OK's `open-knowledge-ui` entry from `<projectRoot>/.claude/launch.json`.
 * A missing file, a file with no OK entry, or a malformed file all map to a
 * structured outcome (`not-present` / `declined`), leaving the file untouched.
 * The one exception is the final `atomicWriteFileSync` (and the `rmSync` for the
 * OK-only case): an I/O failure there propagates — the executor's per-op
 * try/catch surfaces it as a `failed` op.
 */
export function removeOwnLaunchEntry(projectRoot: string): LaunchRemoveOutcome {
  const configPath = join(projectRoot, '.claude', 'launch.json');
  if (!existsSync(configPath)) return { kind: 'not-present' };

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return { kind: 'declined' };
  }

  // parseTree is error-tolerant (returns a best-effort tree, never throws), so a
  // genuinely-malformed file is caught via the errors array — not by a throw —
  // and declined, matching `init.ts`'s `parseJsoncObjectTree`.
  const errors: JsoncParseError[] = [];
  const tree: JsoncNode | undefined = parseTree(raw, errors, JSONC_PARSE_OPTIONS) ?? undefined;
  if (errors.some((e) => !isBenignBomError(e, raw))) return { kind: 'declined' };
  if (!tree || tree.type !== 'object') return { kind: 'declined' };

  const root = getNodeValue(tree) as Record<string, unknown>;
  const configs = root.configurations;
  if (!Array.isArray(configs)) return { kind: 'not-present' };

  const index = configs.findIndex(
    (c) => isObject(c) && (c as Record<string, unknown>).name === LAUNCH_CONFIG_NAME,
  );
  if (index === -1) return { kind: 'not-present' };

  // OK's entry is the only configuration → the file is OK-owned; delete it. An
  // I/O failure here propagates (like the atomicWriteFileSync below) so the
  // executor surfaces it as a `failed` op — a permission error is not a
  // `declined (unparseable)`.
  if (configs.length === 1) {
    rmSync(configPath, { force: true });
    return { kind: 'removed-file' };
  }

  const { text, changed } = surgicalJsonDelete(raw, ['configurations', index]);
  if (!changed) return { kind: 'not-present' };
  atomicWriteFileSync(configPath, text, { mode: existingFileMode(configPath) });
  return { kind: 'removed' };
}
