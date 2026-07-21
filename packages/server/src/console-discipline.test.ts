/**
 * Source-scan STOP rule for server-side logging discipline: non-test server
 * sources route diagnostics through pino `getLogger(name)` (logger.ts), never
 * raw `console.*`. Console output only reaches the terminal; the pino file
 * sink (`.ok/local/logs/server-current.jsonl`) is what bug-report bundles
 * collect, and the packaged desktop app runs the server detached with no
 * persistent stdio — a raw `console.warn` there is a diagnostic dropped on
 * the floor.
 *
 * Two sanctioned exceptions:
 *   1. The structured telemetry-event channel: `console.<level>(JSON.stringify(
 *      { event: ... }))`. This is a designed observation contract — in-process
 *      integration harnesses and e2e suites capture `console.warn` and
 *      string-match `"event":"..."` payloads across package boundaries, so
 *      those emissions stay on console by contract. Detected structurally:
 *      a `JSON.stringify(` within the call's argument window.
 *   2. Whole-file exemptions (`FILE_ALLOWLIST`), each with a structural why:
 *      logger bootstrap paths that cannot log through the logger itself, the
 *      MCP stdio surface where stdout is the JSON-RPC channel, and CLI-run
 *      eval harnesses whose stdout is the user-facing report.
 *
 * The predicate is line-window based, so it has planted-positive +
 * adjacent-negative self-tests below (an absence-checker without a planted
 * positive is a vacuous no-op — same discipline as
 * loopback-bind-discipline.test.ts).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_ROOT = __dirname; // packages/server/src

/** This file embeds the banned patterns as predicate fixtures. */
const SELF_BASENAME = basename(fileURLToPath(import.meta.url));

/**
 * Whole-file exemptions, keyed by path relative to packages/server/src.
 * Every entry needs a reason that explains why pino cannot serve the site.
 */
const FILE_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'logger.ts',
    'pino-pretty bootstrap fallback — the logger cannot report its own construction failure through itself',
  ],
  [
    'local-sink-resolver.ts',
    'resolves the file-sink config the logger is built FROM; runs before any logger is wired',
  ],
  [
    'mcp/logger.ts',
    'MCP stdio logger self-failure path — stdout is the JSON-RPC channel, so this surface writes to stderr/OK_LOG_FILE by design',
  ],
  [
    'mcp/pretty-zod-errors.ts',
    'runs inside the MCP server surface where stdout is the JSON-RPC channel; console.warn targets stderr',
  ],
  [
    'embeddings/eval/semantic-eval.ts',
    'CLI-run eval harness — stdout IS the user-facing report (same carve-out as CLI user-facing stdout)',
  ],
]);

interface FileLines {
  /** Path relative to packages/server/src for failure messages. */
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
        path: relative(SCAN_ROOT, abs),
        lines: readFileSync(abs, 'utf-8').split('\n'),
      });
    }
  }
  walk(SCAN_ROOT);
  return out;
}

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug)\(/;

/**
 * Find raw `console.<level>(` call sites whose argument window (the match
 * line plus up to 2 continuation lines) does NOT open with `JSON.stringify(`
 * — i.e. everything except the sanctioned structured-event channel. The
 * window is small on purpose: every current structured emission puts
 * `JSON.stringify(` on the call line or the immediately following line.
 */
export function findRawConsoleCalls(lines: string[]): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    const m = CONSOLE_CALL.exec(line);
    if (!m) continue;
    const windowText = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n');
    const afterCall = windowText.slice(windowText.indexOf(m[0]) + m[0].length);
    if (/^\s*JSON\.stringify\(/.test(afterCall)) continue;
    violations.push({ line: i + 1, text: line.trim() });
  }
  return violations;
}

describe('console discipline (server sources)', () => {
  const files = listScannedSourceFiles();

  test('there are source files to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path === 'file-watcher.ts')).toBe(true);
  });

  test('every FILE_ALLOWLIST entry still exists on disk', () => {
    const paths = new Set(files.map((f) => f.path));
    for (const allowed of FILE_ALLOWLIST.keys()) {
      expect(paths.has(allowed)).toBe(true);
    }
  });

  test('non-test server sources use getLogger, not raw console.*', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (FILE_ALLOWLIST.has(file.path)) continue;
      for (const v of findRawConsoleCalls(file.lines)) {
        violations.push(`  ${file.path}:${v.line}    ${v.text}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Raw console.* call found in packages/server/src — console output never reaches the pino file sink ` +
          `(.ok/local/logs/server-current.jsonl) that bug-report bundles collect, and the packaged desktop app ` +
          `runs the server detached with no persistent stdio. Use getLogger(name) from './logger.ts' ` +
          `(warn/error still reach the terminal through the console stream). The only sanctioned console shapes ` +
          `are the structured telemetry-event channel (console.<level>(JSON.stringify({ event: ... }))) and the ` +
          `FILE_ALLOWLIST bootstrap/stdio surfaces in console-discipline.test.ts:\n${violations.join('\n')}`,
      );
    }
  });

  test('predicate fires on planted violations and not on adjacent negatives', () => {
    // Planted positives: the raw shapes this rule bans.
    expect(findRawConsoleCalls(["  console.warn('[file-watcher] dropping event');"]).length).toBe(
      1,
    );
    expect(findRawConsoleCalls(["  console.error('failed for path:', err);"]).length).toBe(1);
    expect(findRawConsoleCalls(['  console.log("hi");']).length).toBe(1);
    // Multi-line raw call: first argument is a plain string, not JSON.stringify.
    expect(
      findRawConsoleCalls(['  console.warn(', "    'lstat failed for path',", '  );']).length,
    ).toBe(1);

    // Adjacent negatives: the sanctioned structured-event channel.
    expect(
      findRawConsoleCalls(["  console.warn(JSON.stringify({ event: 'x', docName }));"]).length,
    ).toBe(0);
    expect(
      findRawConsoleCalls(['  console.warn(', '    JSON.stringify({', "      event: 'x',"]).length,
    ).toBe(0);
    expect(
      findRawConsoleCalls(['  console.info(', '    JSON.stringify({', "      event: 'y',"]).length,
    ).toBe(0);

    // Comment-only lines are exempt.
    expect(findRawConsoleCalls(['  // a stray console.warn(x) in prose']).length).toBe(0);
    expect(findRawConsoleCalls([' * logged via `console.warn(...)` so production']).length).toBe(0);

    // getLogger call sites are not console calls at all.
    expect(findRawConsoleCalls(["  getLogger('file-watcher').warn({ err }, 'x');"]).length).toBe(0);

    // Known limitation, pinned: JSON.stringify further than 2 lines below the
    // call is flagged — keep the stringify adjacent to the console call.
    expect(
      findRawConsoleCalls([
        '  console.warn(',
        '    // comment',
        '    // comment',
        '    JSON.stringify({',
      ]).length,
    ).toBe(1);

    // Known limitation, pinned: a trailing inline comment containing the
    // banned pattern false-positives (isCommentOnlyLine only exempts lines
    // that START with a comment marker). Don't write `console.warn(` in a
    // trailing comment — reword the prose instead.
    expect(findRawConsoleCalls(['  doSomething(); // like console.warn(x) did']).length).toBe(1);
  });
});
