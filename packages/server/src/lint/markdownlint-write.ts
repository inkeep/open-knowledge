/**
 * Native markdownlint config WRITE surface. The settings GUI edits the project's
 * own `.markdownlint.*` file (the source of truth — see `markdownlint-discovery`);
 * this merges a single rule change into it, format-preserving and atomic.
 *
 * Read-only discovery + this writer are the only `.markdownlint.*` I/O paths.
 * Writes target the ROOT file even though discovery cascades per-dir — a
 * settings edit is a project-level act; folder files are authored by hand.
 *
 * JSON-family files (`.json` / `.jsonc` / `.markdownlintrc`) are edited via
 * jsonc-parser's minimal text edits, so comments and formatting survive a rule
 * toggle. YAML files round-trip through the parser (whole-object rewrite).
 *
 * Rule identity is alias-aware: markdownlint accepts aliases (`line-length`)
 * as config keys, case-insensitively, last-key-wins. A set edits the key form
 * the user already wrote (the governing — last — one when several address the
 * same rule); a remove deletes EVERY key addressing the rule, since leaving a
 * shadowed alias behind would resurrect the value the user just removed.
 */

import { join } from 'node:path';
import {
  canonicalRuleId,
  DEFAULT_MARKDOWNLINT_CONFIG,
  findRuleConfigEntry,
  type MarkdownlintRuleSetting,
} from '@inkeep/open-knowledge-core';
import { applyEdits, modify, parse as parseJsonc, stripComments } from 'jsonc-parser';
import { stringify as stringifyYaml } from 'yaml';
import { tracedRenameSync, tracedUnlinkSync, tracedWriteFileSync } from '../fs-traced.ts';
import {
  DEFAULT_MARKDOWNLINT_FILENAME,
  findNativeMarkdownlintFile,
  readOwnNativeRules,
} from './markdownlint-discovery.ts';

export interface WriteMarkdownlintResult {
  /**
   * `written` = file created/updated; `deleted` = last rule removed; `noop` =
   * nothing to do; `declined-executable` = the project's native config is an
   * executable `.cjs`/`.mjs` module the write surface must not touch (a JSON
   * rewrite would corrupt it — discovery already surfaces the config as a
   * loud problem, so the edit is refused rather than destructive).
   */
  action: 'written' | 'deleted' | 'noop' | 'declined-executable';
  /** The native filename touched (e.g. `.markdownlint.json`), for diagnostics. */
  file: string;
}

/** YAML for `.yaml`/`.yml`; JSON (2-space) for everything else, including new files. */
function serialize(name: string, rules: Record<string, unknown>): string {
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return stringifyYaml(rules);
  return `${JSON.stringify(rules, null, 2)}\n`;
}

/** The key a set should write through: the governing existing form, else canonical. */
function governingKey(rules: Readonly<Record<string, unknown>>, ruleId: string): string {
  return findRuleConfigEntry(rules, ruleId)?.key ?? canonicalRuleId(ruleId) ?? ruleId;
}

/** Every key in `rules` addressing `ruleId` (canonical + aliases, any case). */
function keysAddressing(rules: Readonly<Record<string, unknown>>, ruleId: string): string[] {
  const canonical = canonicalRuleId(ruleId);
  if (canonical === null) return ruleId in rules ? [ruleId] : [];
  return Object.keys(rules).filter((key) => canonicalRuleId(key) === canonical);
}

const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/** Apply one rule change to raw JSON/JSONC text as minimal, comment-preserving edits. */
function applyJsoncRuleChange(
  raw: string,
  rules: Readonly<Record<string, unknown>>,
  ruleId: string,
  value: MarkdownlintRuleSetting | null,
): string {
  let text = raw;
  if (value === null) {
    for (const key of keysAddressing(rules, ruleId)) {
      text = applyEdits(
        text,
        modify(text, [key], undefined, { formattingOptions: JSONC_FORMATTING }),
      );
    }
    return text;
  }
  const key = governingKey(rules, ruleId);
  return applyEdits(text, modify(text, [key], value, { formattingOptions: JSONC_FORMATTING }));
}

/** Atomic write (tmp + rename), traced; never leaves the tmp file behind. */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    tracedWriteFileSync(tmp, content, 'utf-8');
    tracedRenameSync(tmp, file);
  } catch (err) {
    // The tmp file sits in user-visible content space — never leave an
    // orphan behind on a failed write/rename (same pattern as
    // config-persistence.ts).
    try {
      tracedUnlinkSync(tmp);
    } catch {
      // tmp may not exist if the write itself failed.
    }
    throw err;
  }
}

/**
 * Merge a single rule change into the project's native markdownlint file.
 * `value === null` deletes the rule (reverting it to OK's tuned default); a
 * boolean/params value sets it. Writes back to the existing file + format, or
 * creates `.markdownlint.json` when none exists. Removing the last rule deletes
 * the file — unless the file still carries comments, which are kept (the
 * emptied config keeps governing; deleting a user's commented file is data
 * loss). Atomic (tmp + rename) and traced.
 *
 * A filesystem READ failure on an existing file throws (via
 * `readOwnNativeRules`) — writing through it would rebuild the file from an
 * empty merge base and silently drop every other rule.
 */
export function writeMarkdownlintRule(
  contentDir: string,
  ruleId: string,
  value: MarkdownlintRuleSetting | null,
): WriteMarkdownlintResult {
  const existing = findNativeMarkdownlintFile(contentDir);
  const name = existing?.name ?? DEFAULT_MARKDOWNLINT_FILENAME;
  const file = existing?.path ?? join(contentDir, name);

  // An executable config (matched by the candidate list so its presence is
  // never silently ignored) must not be rewritten: readOwnNativeRules
  // declines it, so the merge base would be {} and serialize would overwrite
  // the module body with bare JSON under a .cjs/.mjs name — silent data loss.
  if (existing && /\.(cjs|mjs|js)$/.test(existing.path)) {
    return { action: 'declined-executable', file: existing.name };
  }

  // Removing a rule that has no file to live in must not create one (the
  // seeded create below would otherwise materialize defaults on a deletion).
  if (!existing && value === null) return { action: 'noop', file: name };

  // Read the file's OWN keys fresh from disk (extends reference preserved,
  // chain NOT flattened) so concurrent edits merge, not clobber, and a rule
  // edit never materializes a resolved extends base into the file. A
  // malformed file (`own === null`) is rewritten cleanly — the documented
  // clobber. When NO file exists yet, the create is seeded with OK's tuned
  // defaults materialized — from that moment the file is the whole story for
  // every native tool, and OK layers nothing under it.
  const own = existing ? readOwnNativeRules(contentDir) : null;
  const isYaml = name.endsWith('.yaml') || name.endsWith('.yml');

  if (existing && own && !isYaml) {
    const text = applyJsoncRuleChange(own.raw, own.rules, ruleId, value);
    const remaining = parseJsonc(text.replace(/^\uFEFF/, ''), [], { allowTrailingComma: true });
    const isEmpty =
      !remaining ||
      typeof remaining !== 'object' ||
      Object.keys(remaining as Record<string, unknown>).length === 0;
    if (isEmpty) {
      // Comments are the whole point of JSONC — keep the file when any
      // survive, even though its config is now empty (an empty governing
      // file keeps governing: native defaults, no OK underlay).
      const hasComments = stripComments(text) !== text;
      if (!hasComments) {
        tracedUnlinkSync(file);
        return { action: 'deleted', file: name };
      }
    }
    writeFileAtomic(file, text);
    return { action: 'written', file: name };
  }

  const rules: Record<string, unknown> = own
    ? { ...own.rules }
    : existing
      ? {}
      : { ...DEFAULT_MARKDOWNLINT_CONFIG };

  if (value === null) {
    for (const key of keysAddressing(rules, ruleId)) delete rules[key];
  } else {
    rules[governingKey(rules, ruleId)] = value;
  }

  if (Object.keys(rules).length === 0) {
    if (existing) {
      tracedUnlinkSync(file);
      return { action: 'deleted', file: name };
    }
    return { action: 'noop', file: name };
  }

  writeFileAtomic(file, serialize(name, rules));
  return { action: 'written', file: name };
}
