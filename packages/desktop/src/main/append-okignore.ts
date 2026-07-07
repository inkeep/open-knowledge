/**
 * `.okignore` appender — used by the consent dialog's "Ignore patterns"
 * field. Three cases for joining new patterns onto whatever's already there:
 *   (a) file absent / empty   → no separator (avoid a leading blank line
 *                                in a fresh file)
 *   (b) ends with newline     → single `\n` separator (existing trailing
 *                                newline + this `\n` = one blank line gap
 *                                visually)
 *   (c) no trailing newline   → `\n\n` separator (close the prior line +
 *                                one blank line gap)
 *
 * Lines whose trimmed form already appears in the existing file are filtered
 * out before appending. Without this, the consent-dialog "Ignore patterns"
 * field stacks a second copy of the seed header at the bottom of a file
 * that already has it whenever a caller (or a paste-from-existing-file user)
 * re-supplies content that's already on disk. Repeats *across calls* — a
 * pattern, blank line, or comment already on disk — drop silently for the
 * same reason. Repeats *within a single input* do NOT dedupe: the existing-
 * line set is built once at entry and never observes input lines, so
 * `appendOkIgnoreSync(dir, 'tmp/\ntmp/')` against an empty file writes
 * `tmp/\ntmp/\n`. Callers that need within-input dedup should pre-dedupe.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function appendOkIgnoreSync(projectDir: string, patterns: string): void {
  const path = join(projectDir, '.okignore');
  const trimmed = patterns.trim();
  if (trimmed.length === 0) return;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const toAppend = filterDuplicateLines(existing, trimmed).trim();
  if (toAppend.length === 0) return;
  const sep = existing.length === 0 ? '' : !existing.endsWith('\n') ? '\n\n' : '\n';
  writeFileSync(path, `${existing + sep + toAppend}\n`, 'utf8');
}

/**
 * Drop lines from `patterns` whose trimmed form already appears in `existing`.
 * Trim-equality (vs. byte-equality) suppresses near-duplicates that differ
 * only in surrounding whitespace (leading or trailing). Reachability via the
 * consent dialog is essentially zero; preserving leading whitespace would
 * matter for hand-authored gitignore syntax where `  foo` (with two leading
 * spaces) matches a path that literally starts with two spaces.
 *
 * The set is flat over trimmed strings — line kinds (`pattern`, `comment`,
 * `blank`) are not preserved separately. Two consequences worth knowing:
 *
 *   - Any blank line the user typed inside `patterns` is dropped whenever
 *     `existing` contains a newline. The split-on-`\n` inserts `''` into the
 *     set even for the trailing newline alone, so user-typed blanks always
 *     collide. Intentional: separator semantics already produce the visual
 *     gap at the boundary, and pattern semantics survive (gitignore ignores
 *     blank lines).
 *   - A bare `#` divider line in `patterns` collides with any bare `#` in
 *     `existing`. Same trade-off — gitignore semantics survive (comment-only
 *     lines are inert) but the visual structure of a fresh comment block
 *     loses its interior dividers.
 *
 * This is asymmetric with `okignore-doc.ts:classifyLine`, which preserves
 * `blank`/`comment` as first-class structural metadata. The asymmetry is
 * intentional for the consent-write append path — the goal here is "don't
 * stack duplicate content"; full structural preservation belongs to the
 * Settings list editor that round-trips byte-identically.
 */
function filterDuplicateLines(existing: string, patterns: string): string {
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  return patterns
    .split('\n')
    .filter((l) => !existingLines.has(l.trim()))
    .join('\n');
}
