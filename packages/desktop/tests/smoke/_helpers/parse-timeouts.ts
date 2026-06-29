
import { readFileSync } from 'node:fs';

const TIMEOUT_LITERAL_RE = /\btimeout:\s*(\d+(?:_\d+)*)/g;
const TOPASS_TIMEOUT_RE = /\.toPass\(\s*\{[^}]*timeout:\s*(\d+(?:_\d+)*)/g;
const DEFAULT_TIMEOUT_ARG_RE = /\btimeoutMs\s*=\s*(\d+(?:_\d+)*)/g;
const FUNCTION_HEADER_RE = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
const TEST_HEADER_RE = /(?:^|\n)\s*test\(\s*(['"`])([^'"`]+)\1/g;
const TEST_SET_TIMEOUT_RE = /\btest\.setTimeout\(\s*(\d+(?:_\d+)*)\s*\)/g;

export interface HelperBudget {
  name: string;
  maxTimeoutMs: number;
}

export interface TestEntry {
  testName: string;
  lineNumber: number;
  perTestTimeoutMs: number | null;
  directTimeoutsMs: number[];
  helperCallNames: string[];
  tracedHelperBudgetsMs: number[];
  cumulativeMs: number;
  toPassBudgetsMs: number[];
}

export interface FileAnalysis {
  filePath: string;
  helpers: HelperBudget[];
  tests: TestEntry[];
}

export interface PlaywrightConfigTimeout {
  ci: number;
  local: number;
  raw: string;
}

export function parseNumericLiteral(raw: string): number {
  return Number.parseInt(raw.replace(/_/g, ''), 10);
}

function findMatchingClose(src: string, openIdx: number): number {
  if (src[openIdx] !== '{') {
    throw new Error(`findMatchingClose: char at ${openIdx} is '${src[openIdx]}', expected '{'`);
  }
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
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

export function stripCommentsAndStrings(src: string): string {
  const out: string[] = new Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i + 1 < src.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      } else {
        if (i < src.length) {
          out[i] = src[i] === '\n' ? '\n' : ' ';
          i += 1;
        }
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i] = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
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

export function extractHelperBudgets(src: string): HelperBudget[] {
  const helpers: HelperBudget[] = [];
  for (const m of src.matchAll(FUNCTION_HEADER_RE)) {
    const name = m[1];
    if (name === 'test' || name === 'describe') continue;
    const headerStart = m.index ?? 0;
    const parenOpenIdx = src.indexOf('(', headerStart + m[0].length - 1);
    if (parenOpenIdx === -1) continue;
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
    for (const dm of argsBlock.matchAll(DEFAULT_TIMEOUT_ARG_RE)) {
      budgets.push(parseNumericLiteral(dm[1]));
    }
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

export function extractTestEntries(src: string, helpers: HelperBudget[]): TestEntry[] {
  const entries: TestEntry[] = [];
  for (const m of src.matchAll(TEST_HEADER_RE)) {
    const testName = m[2];
    const matchStart = m.index ?? 0;
    const testKwOffset = m[0].indexOf('test(');
    const headerStart = matchStart + (testKwOffset >= 0 ? testKwOffset : 0);
    const lineNumber = lineNumberAt(src, headerStart);
    const arrowIdx = src.indexOf('=>', headerStart);
    if (arrowIdx === -1) continue;
    const bodyOpenIdx = src.indexOf('{', arrowIdx);
    if (bodyOpenIdx === -1) continue;
    const bodyCloseIdx = findMatchingClose(src, bodyOpenIdx);
    if (bodyCloseIdx === -1) continue;
    const body = src.slice(bodyOpenIdx + 1, bodyCloseIdx);

    const strippedForTimeouts = stripCommentsAndStrings(body);
    const directTimeoutsMs: number[] = [];
    for (const tm of strippedForTimeouts.matchAll(TIMEOUT_LITERAL_RE)) {
      directTimeoutsMs.push(parseNumericLiteral(tm[1]));
    }
    const toPassBudgetsMs: number[] = [];
    for (const tm of strippedForTimeouts.matchAll(TOPASS_TIMEOUT_RE)) {
      toPassBudgetsMs.push(parseNumericLiteral(tm[1]));
    }
    const setTimeoutMs: number[] = [];
    for (const tm of strippedForTimeouts.matchAll(TEST_SET_TIMEOUT_RE)) {
      setTimeoutMs.push(parseNumericLiteral(tm[1]));
    }
    const perTestTimeoutMs = setTimeoutMs.length > 0 ? Math.max(...setTimeoutMs) : null;
    const strippedBody = stripCommentsAndStrings(body);
    const helperCallNames: string[] = [];
    const tracedHelperBudgetsMs: number[] = [];
    for (const helper of helpers) {
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

export function parseTestFile(filePath: string): FileAnalysis {
  const src = readFileSync(filePath, 'utf8');
  const helpers = extractHelperBudgets(src);
  const tests = extractTestEntries(src, helpers);
  return { filePath, helpers, tests };
}

export function parsePlaywrightConfigTimeout(configPath: string): PlaywrightConfigTimeout {
  const src = readFileSync(configPath, 'utf8');
  const strippedSrc = stripCommentsAndStrings(src);
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
