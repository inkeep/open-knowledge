/**
 * Static parser for Playwright timeout calibration.
 *
 * Pure file-text parser (regex + brace-matching, no TypeScript AST). Reads
 * `packages/desktop/playwright.config.ts` and `tests/smoke/*.e2e.ts` files
 * and extracts the structural calibration that determines whether the suite
 * is over-budget on CI runners.
 *
 * Used by the calibration test to assert the foundational invariant:
 *
 *   For each smoke test, the cumulative inner timeout budget walked by the
 *   test's assertion path must fit within the outer per-test timeout. When
 *   inner cumulative > outer, the test-timeout fires at whatever step is
 *   running when the outer budget exhausts — making attribution unreliable
 *   and producing 3× retry failures (the user's anchor symptom).
 *
 * Why parse the real files (not mock): the test pass/fail must track the
 * actual code. If a future change to `playwright.config.ts` bumps the CI
 * timeout, the parser sees it and the calibration test goes green.
 * Likewise, if a future change adds another 30s helper call inside a smoke
 * test, the parser sees it and the calibration test goes red.
 *
 * Scope: SAME-FILE helper tracing only. Cross-file helpers (e.g. fixtures
 * imported from `_helpers/smoke-test.ts`) are not traced. The smoke files
 * audited here define their own `launchApp` / `findWindowByMode` helpers
 * inline, so same-file tracing captures the cumulative wall-clock budget
 * each test can spend on timeout-bounded operations.
 */

import { readFileSync } from 'node:fs';

const TIMEOUT_LITERAL_RE = /\btimeout:\s*(\d+(?:_\d+)*)/g;
const TOPASS_TIMEOUT_RE = /\.toPass\(\s*\{[^}]*timeout:\s*(\d+(?:_\d+)*)/g;
const DEFAULT_TIMEOUT_ARG_RE = /\btimeoutMs\s*=\s*(\d+(?:_\d+)*)/g;
const FUNCTION_HEADER_RE = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
const TEST_HEADER_RE = /(?:^|\n)\s*test\(\s*(['"`])([^'"`]+)\1/g;
// `test.setTimeout(N)` opts a single test into a larger budget than the
// config-level outer. Captures the literal numeric argument; expressions
// (e.g. `test.setTimeout(BUDGET)`) are not supported — same discipline as
// `parsePlaywrightConfigTimeout`'s ternary-only shape, fails loud rather
// than silently mis-reading.
const TEST_SET_TIMEOUT_RE = /\btest\.setTimeout\(\s*(\d+(?:_\d+)*)\s*\)/g;

/** A same-file helper function and the maximum timeout budget it enforces. */
export interface HelperBudget {
  /** Function name as declared in the source. */
  name: string;
  /**
   * Maximum timeout the helper's body can wait, in milliseconds.
   * Computed as max(default-parameter `timeoutMs`, all literal `timeout:` keys in body).
   * 0 if the helper has no timeout-bounded operations.
   */
  maxTimeoutMs: number;
}

/** A single `test('...', ...)` entry and its calibration data. */
export interface TestEntry {
  /** The string argument passed to `test(...)`. */
  testName: string;
  /** 1-based line number of the test header in the source. */
  lineNumber: number;
  /**
   * Per-test budget override from a `test.setTimeout(N)` call inside the test
   * body, in milliseconds. Null when the test does not declare its own budget
   * (the suite-wide `playwright.config.ts` `timeout` applies). When non-null,
   * this is the budget the cumulative inner timeouts must fit within — not
   * the suite default.
   */
  perTestTimeoutMs: number | null;
  /** Literal `timeout: N` annotations that appear inside the test body (not counting helper bodies). */
  directTimeoutsMs: number[];
  /** Names of same-file helpers called from this test body (parallel array with tracedHelperBudgetsMs). */
  helperCallNames: string[];
  /** Helper-max-timeout budgets attributed via same-file call detection. */
  tracedHelperBudgetsMs: number[];
  /** Sum of `directTimeoutsMs` + `tracedHelperBudgetsMs`. Worst-case wall-clock budget the test can spend on timeout-bounded operations. */
  cumulativeMs: number;
  /** `toPass({ timeout: N })` budgets specifically — for the Invariant-B check on Apple-Event / IPC roundtrip latency. */
  toPassBudgetsMs: number[];
}

/** Per-file calibration analysis. */
export interface FileAnalysis {
  filePath: string;
  helpers: HelperBudget[];
  tests: TestEntry[];
}

/** Outer per-test timeout extracted from `playwright.config.ts`. */
export interface PlaywrightConfigTimeout {
  /** Timeout when `process.env.CI` is truthy. */
  ci: number;
  /** Timeout when `process.env.CI` is falsy. */
  local: number;
  /** Original expression text for debug. */
  raw: string;
}

/** Parse a numeric literal that may contain `_` digit separators. */
export function parseNumericLiteral(raw: string): number {
  return Number.parseInt(raw.replace(/_/g, ''), 10);
}

/**
 * Find the position of the `}` that closes the `{` at `openIdx`. Returns -1
 * if no matching close. Aware of string literals (single/double/backtick),
 * line comments (`//...`), and block comments (`/* ... *\/`) so quotes-in-
 * comments and braces-in-comments don't unbalance the counter. Regex literals
 * are NOT recognized — acceptable for our smoke files, which use regex
 * literals only in `.toMatch(/.../m)` shapes that contain neither `{` nor
 * unbalanced quotes.
 */
function findMatchingClose(src: string, openIdx: number): number {
  if (src[openIdx] !== '{') {
    throw new Error(`findMatchingClose: char at ${openIdx} is '${src[openIdx]}', expected '{'`);
  }
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const c = src[i];
    // Line comment: skip to end-of-line. The trailing newline is left in place
    // so the outer loop's line accounting (if any) stays correct.
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    // Block comment: skip to closing `*/`.
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function lineNumberAt(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i += 1) {
    if (src[i] === '\n') n += 1;
  }
  return n;
}

/**
 * Replace comments and string-literal contents with whitespace of the same
 * length, preserving newlines and positions. Used by helper-call detection
 * and config-timeout extraction so commented-out references or string-literal
 * substrings don't spuriously match. Aware of: `//` line comments, `/*` block
 * comments, single/double/backtick string literals (with `\` escape handling).
 * Regex literals are NOT recognized — acceptable for this codebase.
 *
 * Length-preserving: `output.length === src.length`, and newlines are kept
 * intact so callers using line numbers / offsets stay aligned with the
 * original source.
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = new Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Line comment: replace `//` and the comment text with spaces; keep newline.
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    // Block comment: replace `/* ... */` with spaces; keep newlines inside.
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      // Replace the closing `*/` if present.
      if (i + 1 < src.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      } else {
        // Unterminated block comment: still blank out the remaining char.
        if (i < src.length) {
          out[i] = src[i] === '\n' ? '\n' : ' ';
          i += 1;
        }
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      // Keep the opening quote so syntactic shape is preserved.
      out[i] = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          // Replace both the backslash and the escaped char with spaces
          // (newlines preserved). Two-char step so e.g. `\'` doesn't
          // terminate the string early.
          out[i] = src[i] === '\n' ? '\n' : ' ';
          if (i + 1 < src.length) {
            out[i + 1] = src[i + 1] === '\n' ? '\n' : ' ';
          }
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out[i] = quote;
          i += 1;
          break;
        }
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out[i] = c;
    i += 1;
  }
  return out.join('');
}

/**
 * Extract same-file helper budgets: function declarations whose bodies contain
 * `timeout: N` literals, or whose argument lists declare `timeoutMs = N`
 * defaults. Only top-level `function NAME(...)` declarations are considered
 * (no class methods, no arrow functions stored in const).
 */
export function extractHelperBudgets(src: string): HelperBudget[] {
  const helpers: HelperBudget[] = [];
  for (const m of src.matchAll(FUNCTION_HEADER_RE)) {
    const name = m[1];
    if (name === 'test' || name === 'describe') continue;
    const headerStart = m.index ?? 0;
    // Find the opening `(` of the args.
    const parenOpenIdx = src.indexOf('(', headerStart + m[0].length - 1);
    if (parenOpenIdx === -1) continue;
    // Walk args by paren depth (args can contain nested parens in type annotations).
    let argDepth = 1;
    let argEnd = parenOpenIdx + 1;
    while (argEnd < src.length && argDepth > 0) {
      const c = src[argEnd];
      if (c === '(') argDepth += 1;
      else if (c === ')') argDepth -= 1;
      argEnd += 1;
    }
    if (argDepth !== 0) continue;
    const argsBlock = src.slice(parenOpenIdx + 1, argEnd - 1);
    const bodyOpenIdx = src.indexOf('{', argEnd);
    if (bodyOpenIdx === -1) continue;
    const bodyCloseIdx = findMatchingClose(src, bodyOpenIdx);
    if (bodyCloseIdx === -1) continue;
    const body = src.slice(bodyOpenIdx + 1, bodyCloseIdx);

    const budgets: number[] = [];
    // Default-parameter `timeoutMs = N` — a stable cross-helper naming
    // convention in this codebase's smoke fixtures (findWindowByMode,
    // countWindowsByMode shape).
    for (const dm of argsBlock.matchAll(DEFAULT_TIMEOUT_ARG_RE)) {
      budgets.push(parseNumericLiteral(dm[1]));
    }
    // Literal `timeout: N` inside body (electron.launch, expect.poll, etc.).
    for (const tm of body.matchAll(TIMEOUT_LITERAL_RE)) {
      budgets.push(parseNumericLiteral(tm[1]));
    }
    const maxTimeoutMs = budgets.length > 0 ? Math.max(...budgets) : 0;
    if (maxTimeoutMs > 0) {
      helpers.push({ name, maxTimeoutMs });
    }
  }
  return helpers;
}

/**
 * Extract test entries from a Playwright `*.e2e.ts` file. For each
 * `test('...', ...)` block:
 *  - Sum of literal `timeout: N` annotations directly in the body.
 *  - For each same-file helper called in the body, add its `maxTimeoutMs`.
 *  - All `toPass({ timeout: N })` budgets the body declares.
 *
 * Helper-call detection is name-based (`\bNAME\s*\(`). Helpers without a
 * non-zero `maxTimeoutMs` are not in the helpers[] list, so calls to them
 * contribute nothing — that's the correct behavior for helpers that have
 * no timeout-bounded operations (e.g. `seedTmpHome`, `trackForCleanup`).
 */
export function extractTestEntries(src: string, helpers: HelperBudget[]): TestEntry[] {
  const entries: TestEntry[] = [];
  for (const m of src.matchAll(TEST_HEADER_RE)) {
    const testName = m[2];
    const matchStart = m.index ?? 0;
    // The regex captures `(?:^|\n)\s*` before `test(` and \s matches `\n`,
    // so when an empty line precedes a test header the captured prefix can
    // span multiple lines. Anchor the line number on the actual `test(`
    // keyword position so the reported line matches what a developer sees
    // in their editor.
    const testKwOffset = m[0].indexOf('test(');
    const headerStart = matchStart + (testKwOffset >= 0 ? testKwOffset : 0);
    const lineNumber = lineNumberAt(src, headerStart);
    // Find the arrow function body opening `{`. Walk forward past the test()
    // args until we see `=> {`. (We deliberately don't try to handle the
    // older `function (...) { }` form; this codebase uses arrow callbacks.)
    const arrowIdx = src.indexOf('=>', headerStart);
    if (arrowIdx === -1) continue;
    const bodyOpenIdx = src.indexOf('{', arrowIdx);
    if (bodyOpenIdx === -1) continue;
    const bodyCloseIdx = findMatchingClose(src, bodyOpenIdx);
    if (bodyCloseIdx === -1) continue;
    const body = src.slice(bodyOpenIdx + 1, bodyCloseIdx);

    // Scan a stripped body for both `timeout:` literals and `test.setTimeout`
    // calls so comments / string-literal contents don't spuriously match
    // (same hygiene as the helper-call detection below).
    const strippedForTimeouts = stripCommentsAndStrings(body);
    const directTimeoutsMs: number[] = [];
    for (const tm of strippedForTimeouts.matchAll(TIMEOUT_LITERAL_RE)) {
      directTimeoutsMs.push(parseNumericLiteral(tm[1]));
    }
    const toPassBudgetsMs: number[] = [];
    for (const tm of strippedForTimeouts.matchAll(TOPASS_TIMEOUT_RE)) {
      toPassBudgetsMs.push(parseNumericLiteral(tm[1]));
    }
    // `test.setTimeout(N)` override. If multiple are present (e.g. inside an
    // `if (process.env.CI)` branch and a fallback branch), take the maximum
    // — that's the largest budget the test can run under in any environment,
    // and the calibration invariant must hold for that ceiling.
    const setTimeoutMs: number[] = [];
    for (const tm of strippedForTimeouts.matchAll(TEST_SET_TIMEOUT_RE)) {
      setTimeoutMs.push(parseNumericLiteral(tm[1]));
    }
    const perTestTimeoutMs = setTimeoutMs.length > 0 ? Math.max(...setTimeoutMs) : null;
    // For helper-name detection, scan a body with comments and string-literal
    // contents blanked out. Otherwise a commented-out `// launchApp();` or a
    // helper name appearing inside an error message string (e.g.
    // `throw new Error('launchApp(args) failed')`) would falsely contribute
    // the helper's budget to the cumulative.
    const strippedBody = stripCommentsAndStrings(body);
    const helperCallNames: string[] = [];
    const tracedHelperBudgetsMs: number[] = [];
    for (const helper of helpers) {
      // Match the helper name as an identifier followed by `(`. Avoid matching
      // substring identifiers (e.g. `launch` inside `launchApp`).
      const callRe = new RegExp(`\\b${helper.name}\\s*\\(`, 'g');
      for (const _cm of strippedBody.matchAll(callRe)) {
        helperCallNames.push(helper.name);
        tracedHelperBudgetsMs.push(helper.maxTimeoutMs);
      }
    }
    const cumulativeMs =
      directTimeoutsMs.reduce((a, b) => a + b, 0) +
      tracedHelperBudgetsMs.reduce((a, b) => a + b, 0);
    entries.push({
      testName,
      lineNumber,
      perTestTimeoutMs,
      directTimeoutsMs,
      helperCallNames,
      tracedHelperBudgetsMs,
      cumulativeMs,
      toPassBudgetsMs,
    });
  }
  return entries;
}

/** Read and parse a smoke test file. */
export function parseTestFile(filePath: string): FileAnalysis {
  const src = readFileSync(filePath, 'utf8');
  const helpers = extractHelperBudgets(src);
  const tests = extractTestEntries(src, helpers);
  return { filePath, helpers, tests };
}

/**
 * Extract the outer per-test `timeout` from `defineConfig(...)` in
 * `playwright.config.ts`. Recognizes two shapes:
 *   timeout: 60_000,                              // literal → ci === local
 *   timeout: process.env.CI ? 120_000 : 60_000,   // ternary on CI
 *
 * Throws if the shape isn't one of the two — adding a new shape (e.g.
 * `timeout: TIMEOUT_CONST`) should fail loudly rather than silently
 * misreporting the budget.
 */
export function parsePlaywrightConfigTimeout(configPath: string): PlaywrightConfigTimeout {
  const src = readFileSync(configPath, 'utf8');
  // Strip comments and string-literal contents before matching so a stale
  // `// timeout: 30_000, before bump` line above the real config can't be
  // captured first by the `timeout:` regex.
  const strippedSrc = stripCommentsAndStrings(src);
  // Capture the value after `timeout:` up to the line-ending comma. We use
  // `[^,\n]+` so the value can contain `?`, `:`, `.`, `_`, etc. — all of
  // which appear in `process.env.CI ? 120_000 : 60_000`.
  const m = strippedSrc.match(/\btimeout:\s*([^,\n]+?)\s*,/);
  if (!m) throw new Error(`No top-level \`timeout:\` found in ${configPath}`);
  const raw = m[1].trim();
  const literal = raw.match(/^(\d+(?:_\d+)*)$/);
  if (literal) {
    const n = parseNumericLiteral(literal[1]);
    return { ci: n, local: n, raw };
  }
  const ternary = raw.match(/^process\.env\.CI\s*\?\s*(\d+(?:_\d+)*)\s*:\s*(\d+(?:_\d+)*)$/);
  if (ternary) {
    return {
      ci: parseNumericLiteral(ternary[1]),
      local: parseNumericLiteral(ternary[2]),
      raw,
    };
  }
  throw new Error(
    `parsePlaywrightConfigTimeout: unsupported \`timeout:\` shape in ${configPath} — got "${raw}"`,
  );
}
