/**
 * Precedent #13(b) enforcement — bridge observers are settlement-based,
 * never wall-clock debounce.
 *
 * Scans the two bridge observer source files at runtime:
 *   - `packages/server/src/server-observers.ts` — server-authoritative
 *     observer (`afterAllTransactions` settlement dispatch)
 *   - `packages/app/src/editor/observers.ts` — client observer shell
 *     (diagnostic parse validation)
 *
 * Forbidden patterns (any match fails CI):
 *   - `setTimeout(` / `setInterval(` — wall-clock scheduling calls
 *   - `sched.setTimeout(` / `sched.clearTimeout(` / `sched.setInterval(`
 *     — historical Scheduler-DI call sites
 *   - `new Scheduler(` / `: Scheduler` / `Scheduler<` — active Scheduler
 *     type consumption (indicates debounce machinery)
 *
 * Comments and JSDoc referencing the retired machinery are allowed — the
 * forbidden regex targets call-site forms (parenthesis-after-identifier)
 * and type-annotation forms.
 *
 * Intentional omission: no allow-list file carve-outs inside this gate.
 * If a legitimate future reason emerges (e.g., a specific sanctioned
 * setTimeout for an escape-hatch retry), document it by narrowing the
 * scanned set or gating with a structured marker — don't silently
 * allow-list individual lines. Greenfield posture.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve repo root deterministically from this file's own path.
// packages/server/src/<this>.test.ts → ../../.. = repo root.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/**
 * Files guarded by precedent #13(b). Each must be free of the forbidden
 * patterns.
 */
const GUARDED_FILES = [
  'packages/server/src/server-observers.ts',
  'packages/app/src/editor/observers.ts',
] as const;

/**
 * Forbidden patterns. Each entry carries a human-readable name so the
 * failure message points at the specific rule that fired.
 *
 * We match parenthesis-after-identifier for function-like calls (so
 * `setTimeout` appearing inside a comment or a word like "setTimeout-free"
 * does NOT match) and type-position consumption for Scheduler types.
 */
const FORBIDDEN: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'setTimeout() call', regex: /\bsetTimeout\s*\(/ },
  { name: 'setInterval() call', regex: /\bsetInterval\s*\(/ },
  { name: 'sched.setTimeout() call', regex: /\bsched\.setTimeout\s*\(/ },
  { name: 'sched.clearTimeout() call', regex: /\bsched\.clearTimeout\s*\(/ },
  { name: 'sched.setInterval() call', regex: /\bsched\.setInterval\s*\(/ },
  { name: 'sched.clearInterval() call', regex: /\bsched\.clearInterval\s*\(/ },
  { name: 'new Scheduler(…) construction', regex: /\bnew\s+Scheduler\s*\(/ },
  { name: ': Scheduler type annotation', regex: /:\s*Scheduler\b/ },
  { name: '<Scheduler> generic consumption', regex: /<\s*Scheduler\b/ },
];

/**
 * Strip `//` line comments and `/* ... *\/` block comments from a source
 * text so the regex scan only sees executable tokens. Handles strings
 * conservatively: we don't do full lexical analysis, but we do skip
 * backtick/single/double-quoted strings so call-pattern matches inside
 * template-literal explanations are ignored.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Block comment
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      // Preserve newlines so the reported line numbers stay accurate.
      for (let j = i; j < end + 2; j++) if (src[j] === '\n') out += '\n';
      i = end + 2;
      continue;
    }
    // Line comment
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      if (end < 0) break;
      out += '\n';
      i = end + 1;
      continue;
    }
    // Single/double/backtick strings — skip content, preserve newlines.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          // Preserve escape but don't advance into it as source.
          if (src[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (ch === quote) {
          out += ch;
          i++;
          break;
        }
        if (ch === '\n') out += '\n';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe('Precedent #13(b): no wall-clock setTimeout in bridge observers (SPEC R6)', () => {
  for (const relPath of GUARDED_FILES) {
    test(`${relPath} is free of forbidden wall-clock / Scheduler patterns`, () => {
      const absPath = join(repoRoot, relPath);
      const src = readFileSync(absPath, 'utf8');
      const stripped = stripCommentsAndStrings(src);
      const lines = stripped.split('\n');
      const violations: Array<{ line: number; rule: string; text: string }> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const rule of FORBIDDEN) {
          if (rule.regex.test(line)) {
            violations.push({ line: i + 1, rule: rule.name, text: line.trim() });
          }
        }
      }
      if (violations.length > 0) {
        const details = violations
          .map((v) => `  ${relPath}:${v.line} [${v.rule}]  ${v.text}`)
          .join('\n');
        throw new Error(
          `Precedent #13(b) violation in bridge observer file:\n${details}\n\n` +
            `These patterns indicate wall-clock debounce or Scheduler-DI usage in bridge code. ` +
            `Dispatch must flow through doc.on('afterAllTransactions', ...) (SPEC 2026-04-16 ` +
            `bridge-correctness §6 R4, D5-LOCKED). If a specific exception is required, surface ` +
            `it in the SPEC / CLAUDE.md §STOP rules before adjusting the allow-list here.`,
        );
      }
      expect(violations).toEqual([]);
    });
  }

  test('meta: GUARDED_FILES entries exist on disk', () => {
    for (const relPath of GUARDED_FILES) {
      const absPath = join(repoRoot, relPath);
      // readFileSync throws if the file is missing — that's the assertion.
      const src = readFileSync(absPath, 'utf8');
      expect(src.length).toBeGreaterThan(0);
    }
  });
});
