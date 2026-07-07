/**
 * Source-scan STOP rule for the rig socket-ownership invariant (executable
 * statement: loopback-exclusivity.test.ts): test code that boots an HTTP/WS
 * rig must bind a loopback-specific address (`'127.0.0.1'` / `'::1'`) and
 * must dial the bound literal — never the ambiguous name `localhost`, whose
 * `::1`-first resolution is exactly the slot a foreign process can hold
 * while the rig sits on a wildcard bind.
 *
 * Two predicates, scanned over this package's Bun-test rig surfaces
 * (`tests/integration/**` including the shared test-harness, plus the whole
 * stress suite — `tests/stress/**`, Playwright `*.e2e.ts` specs included):
 *   1. `.listen(…)` calls whose argument window carries no quoted loopback
 *      host literal — a bare `listen(0)` binds the IPv6 wildcard `::`,
 *      whose loopback-specific port slots stay bindable by foreign
 *      processes (silently, no EADDRINUSE).
 *   2. `http(s)://localhost:${…}` / `ws(s)://localhost:${…}` dial strings —
 *      interpolated-port localhost URLs are rig dials by construction.
 *      Consumer tests inherit this pattern from the harness exposing only
 *      `port`; the compliant shape dials a harness-advertised bound-literal
 *      base URL. (Fixed-port strings like `http://localhost:5173` are
 *      expectation fixtures, not rig dials — out of scope.)
 *
 * The predicates are line-window based, so they have planted-positive +
 * adjacent-negative self-tests below (an absence-checker without a planted
 * positive is a vacuous no-op — same discipline as e2e-stop-rules.test.ts).
 *
 * Sibling copies (same predicate bodies, different scan scopes):
 * packages/server/src/loopback-bind-discipline.test.ts and
 * packages/cli/src/loopback-bind-discipline.test.ts — keep the predicates
 * aligned on any-side change. The copies are per-package so each package's
 * test cache invalidates with its own sources.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = [__dirname, join(PACKAGE_ROOT, 'tests', 'stress')];

/** This file embeds the banned patterns as predicate fixtures. */
const SELF_BASENAME = basename(fileURLToPath(import.meta.url));

interface FileLines {
  /** Package-relative path for failure messages. */
  path: string;
  lines: string[];
}

function listScannedFiles(): FileLines[] {
  const out: FileLines[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name === SELF_BASENAME) continue;
      out.push({
        path: relative(PACKAGE_ROOT, abs),
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

const LOOPBACK_HOST_LITERAL = /['"](?:127\.0\.0\.1|::1)['"]/;

/**
 * Find `.listen(` calls with no quoted loopback host literal in the
 * argument window (the match line plus up to 3 continuation lines,
 * truncated at the first `)`). Every current call site is single-line; the
 * window absorbs simple formatting drift. Known limitation (pinned by the
 * self-test): a host passed as a variable is flagged even if its value is
 * loopback — inline the literal at the `.listen(` call so the scan can see
 * it.
 */
export function findNonLoopbackListenCalls(lines: string[]): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    const idx = line.indexOf('.listen(');
    if (idx === -1) continue;
    let window = line.slice(idx);
    for (let j = i + 1; j <= i + 3 && !window.includes(')') && j < lines.length; j++) {
      window += `\n${lines[j] ?? ''}`;
    }
    const paren = window.indexOf(')');
    if (paren !== -1) window = window.slice(0, paren + 1);
    if (!LOOPBACK_HOST_LITERAL.test(window)) {
      violations.push({ line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

const AMBIGUOUS_LOCALHOST_DIAL = /\b(?:https?|wss?):\/\/localhost:\$\{/;

/**
 * Find interpolated-port `localhost` URL constructions (`http://localhost:${…}`
 * et al.). The compliant shape dials the literal the rig actually bound
 * (e.g. `http://127.0.0.1:${port}` or a rig-advertised base URL).
 */
export function findAmbiguousLocalhostDials(
  lines: string[],
): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    if (AMBIGUOUS_LOCALHOST_DIAL.test(line)) {
      violations.push({ line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

describe('loopback bind discipline (app test sources)', () => {
  const files = listScannedFiles();

  test('there are test files to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path.endsWith('integration/test-harness.ts'))).toBe(true);
    expect(files.some((f) => f.path.endsWith('_helpers/server-process.ts'))).toBe(true);
    // The stress root covers the Playwright specs themselves, not just helpers.
    expect(files.some((f) => f.path.endsWith('.e2e.ts'))).toBe(true);
  });

  test('every .listen( call binds an explicit loopback host literal', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const v of findNonLoopbackListenCalls(file.lines)) {
        violations.push(`  ${file.path}:${v.line}    ${v.text}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Hostless rig bind found — a bare listen(0) binds the IPv6 wildcard '::', whose loopback-specific ` +
          `port slots stay silently bindable by foreign processes; their listeners then intercept this rig's ` +
          `localhost dials (the rotating integration-suite flake). Bind a loopback-specific host ` +
          `(e.g. listen(0, '127.0.0.1', cb)) and dial the literal from server.address():\n${violations.join('\n')}`,
      );
    }
  });

  test('no interpolated-port localhost dial URLs', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const v of findAmbiguousLocalhostDials(file.lines)) {
        violations.push(`  ${file.path}:${v.line}    ${v.text}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Ambiguous-name rig dial found — 'localhost' resolves '::1'-first, exactly the loopback-specific slot ` +
          `a foreign process can hold while the rig sits on a wildcard (or single-family) bind. Dial the ` +
          `literal address the rig actually bound (a harness-advertised base URL, or ` +
          `http://127.0.0.1:\${port}):\n${violations.join('\n')}`,
      );
    }
  });

  test('listen predicate fires on planted violations and not on adjacent negatives', () => {
    // Planted positives: the hostless shapes the harness and helpers use.
    expect(findNonLoopbackListenCalls(['  s.listen(0, () => {']).length).toBe(1);
    expect(
      findNonLoopbackListenCalls(['    httpServer.listen(port, () => resolve());']).length,
    ).toBe(1);

    // Adjacent negatives: loopback-literal binds, both families.
    expect(findNonLoopbackListenCalls(["  server.listen(0, '127.0.0.1', resolve);"]).length).toBe(
      0,
    );
    expect(findNonLoopbackListenCalls(["  s.listen(port, '::1', cb);"]).length).toBe(0);

    // Multi-line call with the host on a continuation line stays compliant
    // (the argument window spans up to 3 continuation lines).
    expect(
      findNonLoopbackListenCalls(['  server.listen(', '    0,', "    '127.0.0.1',", '    cb)'])
        .length,
    ).toBe(0);

    // Comment-only lines are exempt.
    expect(findNonLoopbackListenCalls(['  // before httpServer.listen() resolves']).length).toBe(0);
    expect(
      findNonLoopbackListenCalls([' * boot scan runs BEFORE httpServer.listen().']).length,
    ).toBe(0);

    // Known limitation, pinned: a variable host is flagged even when its
    // value is loopback — inline the literal so the scan can verify it.
    expect(findNonLoopbackListenCalls(['  s.listen(port, host, cb);']).length).toBe(1);

    // Non-loopback literal host is a violation (wildcard by another name).
    expect(findNonLoopbackListenCalls(["  s.listen(0, '0.0.0.0', cb);"]).length).toBe(1);
  });

  test('dial predicate fires on planted violations and not on adjacent negatives', () => {
    // Planted positives: the dial shapes the harness and consumers use.
    expect(
      findAmbiguousLocalhostDials([
        `  const res = await fetch(\`http://localhost:\${server.port}/api/documents\`);`,
      ]).length,
    ).toBe(1);
    expect(
      findAmbiguousLocalhostDials([`    url: \`ws://localhost:\${port}/collab\`,`]).length,
    ).toBe(1);

    // Adjacent negatives: literal-host dials.
    expect(
      findAmbiguousLocalhostDials([`  const res = await fetch(\`http://127.0.0.1:\${port}/x\`);`])
        .length,
    ).toBe(0);

    // Fixed-port localhost strings are expectation fixtures, not rig dials
    // (pinned limitation — a fixed-port dial would be missed).
    expect(
      findAmbiguousLocalhostDials(["  expect(url).toBe('ws://localhost:7777/collab');"]).length,
    ).toBe(0);

    // Comment-only lines are exempt.
    expect(findAmbiguousLocalhostDials([`  // dials http://localhost:\${port} today`]).length).toBe(
      0,
    );

    // Bare host:port strings without a scheme (Host-header fixtures) are
    // not dials.
    expect(findAmbiguousLocalhostDials(["  host: 'localhost:5173',"]).length).toBe(0);
  });
});
