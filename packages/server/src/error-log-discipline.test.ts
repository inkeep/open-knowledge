/**
 * Source-scan STOP rule for error-log payload discipline: error/warn logger
 * calls pass the RAW error value under the `err` key — never a
 * string-coerced copy (`err.message`, `String(err)`, `(err as
 * Error).message`, `x instanceof Error ? x.message : String(x)`). The pino
 * serializers on both the server logger (`logger.ts`) and the desktop root
 * logger (`desktop-logger.ts`) capture name/message/stack from a raw Error;
 * a pre-coerced string discards the stack, which is the difference between
 * a correlatable JSONL bundle line and a dead-end one.
 *
 * Scope mirrors the Node-side logging surface: `packages/server/src`,
 * `packages/cli/src`, and `packages/desktop/src/main` (renderer is not
 * pino-backed). `console.*` receivers are exempt — the two sanctioned
 * console.warn styles (bracket-prefix; structured JSON) are their own
 * convention and stay out of this rule's reach.
 *
 * Escape hatch: suffix the offending line (or the call line) with
 * `// error-log-shape-ok: <why>` for a site where a string copy is the
 * point (e.g. capturing a message snapshot alongside the raw err), or add
 * a FILE_ALLOWLIST entry with a structural reason for a whole surface.
 *
 * The predicate is line-window based, so it has planted-positive +
 * adjacent-negative self-tests below (an absence-checker without a planted
 * positive is a vacuous no-op — same discipline as
 * console-discipline.test.ts).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const SCAN_ROOTS = [
  resolve(__dirname),
  resolve(__dirname, '../../cli/src'),
  resolve(__dirname, '../../desktop/src/main'),
];

const SELF_BASENAME = basename(fileURLToPath(import.meta.url));

const FILE_ALLOWLIST: ReadonlyMap<string, string> = new Map([]);

const MARKER = 'error-log-shape-ok:';

interface FileLines {
  path: string;
  lines: string[];
}

function listScannedSourceFiles(): FileLines[] {
  const out: FileLines[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test-helper.ts')) continue;
      if (entry.name === SELF_BASENAME) continue;
      out.push({
        path: relative(WORKSPACE_ROOT, abs),
        lines: readFileSync(abs, 'utf-8').split('\n'),
      });
    }
  }
  for (const root of SCAN_ROOTS) walk(root);
  return out;
}

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const LOG_CALL = /(?<!console)\.(error|warn)\(/;

const BANNED_FIELD = [
  /\b(?:err|error|cause)\s*:\s*String\(/,
  /\b(?:err|error|cause)\s*:\s*\(?\s*\w+(?:\s+as\s+\w+)?\s*\)?\s*\.message\b/,
  /\b(?:err|error|cause|message)\s*:\s*\(?\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message\s*:/,
  /\bmessage\s*:\s*\(?\s*(?:e|err|error|\w*[eE]rr(?:or)?)(?:\s+as\s+\w+)?\s*\)?\s*\.message\b/,
];

const WINDOW_LINES = 8;

export interface ErrorLogViolation {
  line: number;
  text: string;
}

export function findStringifiedErrorFields(lines: string[]): ErrorLogViolation[] {
  const violations: ErrorLogViolation[] = [];
  const flagged = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    const m = LOG_CALL.exec(line);
    if (!m) continue;
    if (line.includes(MARKER)) continue;
    let depth = 0;
    for (let w = 0; w < WINDOW_LINES && i + w < lines.length; w++) {
      const wLine = lines[i + w] ?? '';
      const segment = w === 0 ? wLine.slice(wLine.indexOf(m[0]) + m[0].length - 1) : wLine;
      if (!isCommentOnlyLine(wLine) && !wLine.includes(MARKER)) {
        const testable = w === 0 ? segment.slice(1) : segment;
        if (BANNED_FIELD.some((re) => re.test(testable))) {
          if (!flagged.has(i + w)) {
            flagged.add(i + w);
            violations.push({ line: i + 1 + w, text: wLine.trim() });
          }
          break;
        }
      }
      for (const ch of segment) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      if (depth <= 0) break;
    }
  }
  return violations;
}

describe('error-log payload discipline (server + cli + desktop main)', () => {
  test('every scan root exists (layout sanity)', () => {
    for (const root of SCAN_ROOTS) {
      expect(existsSync(root)).toBe(true);
    }
  });

  const files = listScannedSourceFiles();

  test('there are source files to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path === join('packages', 'server', 'src', 'file-watcher.ts'))).toBe(
      true,
    );
    expect(
      files.some((f) => f.path === join('packages', 'desktop', 'src', 'main', 'auto-updater.ts')),
    ).toBe(true);
  });

  test('every FILE_ALLOWLIST entry still exists on disk', () => {
    const paths = new Set(files.map((f) => f.path));
    for (const allowed of FILE_ALLOWLIST.keys()) {
      expect(paths.has(allowed)).toBe(true);
    }
  });

  test('error/warn logger calls pass the raw error under err, not a string copy', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (FILE_ALLOWLIST.has(file.path)) continue;
      for (const v of findStringifiedErrorFields(file.lines)) {
        violations.push(`  ${file.path}:${v.line}    ${v.text}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `String-coerced error field found in an error/warn log call. Pass the RAW error under ` +
          `the \`err\` key (\`log.warn({ err }, '...')\`) — the pino serializers capture ` +
          `name/message/stack; \`err.message\` / \`String(err)\` discard the stack the JSONL ` +
          `bundle needs. For a site where a string copy is genuinely intended, suffix the line ` +
          `with \`// ${MARKER} <why>\` or add a FILE_ALLOWLIST entry in ` +
          `error-log-discipline.test.ts:\n${violations.join('\n')}`,
      );
    }
  });

  test('predicate fires on planted violations and not on adjacent negatives', () => {
    expect(findStringifiedErrorFields(["  log.warn({ err: String(err) }, 'x');"]).length).toBe(1);
    expect(
      findStringifiedErrorFields(['  logger.warn(', "    { event: 'x', error: String(err) },"])
        .length,
    ).toBe(1);
    expect(findStringifiedErrorFields(["  log.error({ err: err.message }, 'x');"]).length).toBe(1);
    expect(
      findStringifiedErrorFields(["  log.warn({ err: (e as Error).message }, 'x');"]).length,
    ).toBe(1);
    expect(
      findStringifiedErrorFields([
        '  logger.error({',
        '    err: err instanceof Error ? err.message : String(err),',
        '  });',
      ]).length,
    ).toBe(1);
    expect(
      findStringifiedErrorFields([
        '  deps.logger.warn(',
        '    {',
        "      event: 'x',",
        '      cause: err instanceof Error ? err.message : String(err),',
        '    },',
      ]).length,
    ).toBe(1);
    expect(
      findStringifiedErrorFields(["  logger.error('failed', { message: err.message });"]).length,
    ).toBe(1);

    expect(findStringifiedErrorFields(["  log.warn({ err }, 'x');"]).length).toBe(0);
    expect(findStringifiedErrorFields(["  log.error({ err: e, docName }, 'x');"]).length).toBe(0);
    expect(
      findStringifiedErrorFields([
        "  log.warn({ err: err instanceof Error ? err : new Error(String(err)) }, 'x');",
      ]).length,
    ).toBe(0);
    expect(
      findStringifiedErrorFields(["  console.warn('[main] x', { err: (err as Error).message });"])
        .length,
    ).toBe(0);
    expect(
      findStringifiedErrorFields([
        '  logger.warn({ issues: x.map((i) => ({ path: i.path, message: i.message })) });',
      ]).length,
    ).toBe(0);
    expect(
      findStringifiedErrorFields(["  log.warn({ message: result.message }, 'x');"]).length,
    ).toBe(0);
    expect(
      findStringifiedErrorFields(['  // like log.warn({ err: String(err) }) used to']).length,
    ).toBe(0);
    expect(
      findStringifiedErrorFields([
        "  log.warn({ err: String(err) }, 'x'); // error-log-shape-ok: message snapshot on purpose",
      ]).length,
    ).toBe(0);

    expect(
      findStringifiedErrorFields([
        "  log.warn({ err }, 'x');",
        '  phaseErrors.push({ phase: "y", error: String(err) });',
      ]).length,
    ).toBe(0);

    expect(
      findStringifiedErrorFields([
        '  log.warn(',
        '    {',
        '      a: 1,',
        '      b: 2,',
        '      c: 3,',
        '      d: 4,',
        '      e: 5,',
        '      f: 6,',
        '      err: String(err),',
        '    },',
      ]).length,
    ).toBe(0);
  });
});
