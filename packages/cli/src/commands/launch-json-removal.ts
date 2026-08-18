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
 * The containing file is never deleted, even when the generated entry was its
 * only configuration: top-level settings remain user-owned.
 */

import { existsSync, readFileSync } from 'node:fs';
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

  const index = configs.findIndex(isOwnLaunchEntry);
  if (index === -1) return { kind: 'not-present' };

  const { text, changed } = surgicalJsonDelete(raw, ['configurations', index]);
  if (!changed) return { kind: 'not-present' };
  atomicWriteFileSync(configPath, text, { mode: existingFileMode(configPath) });
  return { kind: 'removed' };
}

function isOwnLaunchEntry(value: unknown): boolean {
  if (!isObject(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.name !== LAUNCH_CONFIG_NAME || !Array.isArray(entry.runtimeArgs)) return false;
  const args = entry.runtimeArgs;
  if (entry.runtimeExecutable === '/bin/sh') {
    return (
      args.length === 3 &&
      args[0] === '-l' &&
      args[1] === '-c' &&
      typeof args[2] === 'string' &&
      /^# ok-ui-v[1-9]\d*$/.test(args[2].split(/\r?\n/, 1)[0] ?? '')
    );
  }
  if (entry.runtimeExecutable === 'npx') {
    return LEGACY_NPX_UI_FORMS.some((form) => argsExactlyMatch(args, form));
  }
  return (
    entry.runtimeExecutable === 'powershell' &&
    args.length === 4 &&
    args[0] === '-NoProfile' &&
    args[1] === '-NonInteractive' &&
    args[2] === '-Command' &&
    typeof args[3] === 'string' &&
    /^# ok-ui-win-v[1-9]\d*$/.test(args[3].split(/\r?\n/, 1)[0] ?? '')
  );
}

const LEGACY_NPX_UI_FORMS: ReadonlyArray<readonly string[]> = [
  ['@inkeep/open-knowledge', 'ui'],
  ['-y', '@inkeep/open-knowledge', 'ui'],
  ['-y', '@inkeep/open-knowledge@latest', 'ui'],
];

function argsExactlyMatch(actual: readonly unknown[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);
}
