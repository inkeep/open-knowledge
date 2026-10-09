import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_LAUNCH_TIMEOUT_MS,
  ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS,
  resolveDesktopTarget,
} from './launch-desktop';
import { type ReadinessPath, readinessGiveUpBoundMs, readinessPathOf } from './launch-readiness';

const TIMEOUT_VALUE_RE = /\btimeout:\s*/g;
const LAUNCH_HELPER_CALL_RE = /\bdesktopLaunchOptions\(/;

const READINESS_HELPER_CALL_RE = /\bwaitForWindowByMode\s*\(/g;

const READINESS_OPTION_PROPERTY_RE = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/;
const NUMERIC_LITERAL_RE = /^(\d+(?:_\d+)*)$/;
const TOPASS_TIMEOUT_RE = /\.toPass\(\s*\{[^}]*timeout:\s*/g;
const DEFAULT_TIMEOUT_ARG_RE = /\btimeoutMs\s*=\s*/g;
const LEADING_NUMERIC_LITERAL_RE = /^\d+(?:_\d+)*/;
const CONST_DECLARATION_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*/g;
const NAMED_IMPORT_RE = /\bimport\s*\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const TYPE_WORD_RE = /[\w$]+/y;
const TYPE_OPERATOR_WORDS: ReadonlySet<string> = new Set([
  'keyof',
  'typeof',
  'extends',
  'is',
  'readonly',
  'infer',
  'unique',
]);
const FUNCTION_HEADER_RE = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
const TEST_HEADER_RE =
  /(?:^|\n)\s*test(?:\.only|\.fail(?:\.only)?)?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TEST_SET_TIMEOUT_RE = /\btest\.setTimeout\(/g;
const DERIVED_OUTER_RE = /^sumOfDeclaredBoundsMs\(\s*test\.info\(\s*\)\s*\)$/;
const ARITHMETIC_TOKEN_RE = /\d+(?:_\d+)*|[A-Za-z_$][\w$]*|[()+*]|\S/g;

export interface ChargeTier {
  path: ReadinessPath;
}

type DeclaredConstants = ReadonlyMap<string, number>;

const UNPACKAGED_CHARGE_TIER: ChargeTier = { path: readinessPathOf('unpackaged') };

type ReadinessBudgetKey = 'capMs' | 'stallMs' | 'pollMs';

type ReadinessBudgets = Partial<Record<ReadinessBudgetKey, number>>;

const READINESS_BUDGET_KEYS: ReadonlySet<string> = new Set<ReadinessBudgetKey>([
  'capMs',
  'stallMs',
  'pollMs',
]);

function isReadinessBudgetKey(key: string): key is ReadinessBudgetKey {
  return READINESS_BUDGET_KEYS.has(key);
}

export interface HelperBudget {
  name: string;
  maxTimeoutMs: number;
}

type PerTestOuter =
  | { perTestTimeoutSource: 'literal'; perTestTimeoutMs: number }
  | { perTestTimeoutSource: 'sum-of-declared-bounds'; perTestTimeoutMs: number }
  | { perTestTimeoutSource: null; perTestTimeoutMs: null };

export type TestEntry = PerTestOuter & TestEntryBudgets;

interface TestEntryBudgets {
  testName: string;
  lineNumber: number;
  directTimeoutsMs: number[];
  helperCallNames: string[];
  tracedHelperBudgetsMs: number[];
  cumulativeMs: number;
  toPassBudgetsMs: number[];
  bodyRange: readonly [number, number];
}

export interface FileAnalysis {
  filePath: string;
  helpers: HelperBudget[];
  tests: TestEntry[];
  looseSetTimeoutLines: number[];
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

function locatorFor(filePath: string | undefined): (line: number) => string {
  return (line) => (filePath === undefined ? `line ${line}` : `${filePath}:${line}`);
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

function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function expressionAt(text: string, start: number): string {
  let depth = 0;
  let end = start;
  for (; end < text.length; end += 1) {
    const c = text[end];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (c === ',' || c === ';' || c === '\n')) break;
  }
  return text.slice(start, end).trim();
}

function chargesAfter(text: string, prefix: RegExp, constants: DeclaredConstants): number[] {
  const charges: number[] = [];
  for (const m of text.matchAll(prefix)) {
    const expression = expressionAt(text, (m.index ?? 0) + m[0].length);
    const leading = expression.match(LEADING_NUMERIC_LITERAL_RE);
    const valueMs =
      evaluateArithmetic(expression, constants) ??
      (leading === null ? undefined : parseNumericLiteral(leading[0]));
    if (valueMs !== undefined) charges.push(valueMs);
  }
  return charges;
}

function moduleFileOf(specifierPath: string): string | undefined {
  return [specifierPath, `${specifierPath}.ts`].find(
    (candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true,
  );
}

function importedConstantsOf(src: string, filePath: string): Map<string, number> {
  const constants = new Map<string, number>();
  for (const m of src.matchAll(NAMED_IMPORT_RE)) {
    const modulePath = moduleFileOf(resolve(dirname(filePath), m[2]));
    if (modulePath === undefined) continue;
    const exported = declaredConstantsOf(readFileSync(modulePath, 'utf8'));
    for (const specifier of m[1].split(',')) {
      const [imported, local = imported] = specifier.trim().split(/\s+as\s+/);
      const valueMs = exported.get(imported);
      if (valueMs !== undefined) constants.set(local, valueMs);
    }
  }
  return constants;
}

function declaredConstantsOf(src: string, filePath?: string): DeclaredConstants {
  const constants =
    filePath === undefined ? new Map<string, number>() : importedConstantsOf(src, filePath);
  const stripped = stripCommentsAndStrings(src);
  for (const m of stripped.matchAll(CONST_DECLARATION_RE)) {
    const expression = expressionAt(stripped, (m.index ?? 0) + m[0].length);
    const valueMs = evaluateArithmetic(expression, constants);
    if (valueMs !== undefined) constants.set(m[1], Math.max(valueMs, constants.get(m[1]) ?? 0));
  }
  return constants;
}

function functionBodyOpenAfter(src: string, paramsEnd: number): number | undefined {
  let i = paramsEnd;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== ':') return src.indexOf('{', paramsEnd);
  let depth = 0;
  let expectsType = true;
  for (i += 1; i < src.length; i += 1) {
    const c = src[i];
    if (/\s/.test(c)) continue;
    if (c === ';') return -1;
    if (c === '{') {
      if (depth === 0 && !expectsType) return i;
      i = findMatchingClose(src, i);
      if (i === -1) return undefined;
      expectsType = false;
      continue;
    }
    if (c === '=' && src[i + 1] === '>') {
      i += 1;
      expectsType = true;
      continue;
    }
    TYPE_WORD_RE.lastIndex = i;
    const word = TYPE_WORD_RE.exec(src)?.[0];
    if (word !== undefined) {
      i += word.length - 1;
      expectsType = TYPE_OPERATOR_WORDS.has(word);
      continue;
    }
    if (c === '<' || c === '(' || c === '[') depth += 1;
    else if (c === '>' || c === ')' || c === ']') depth -= 1;
    expectsType = '<([|&,:?'.includes(c);
  }
  return undefined;
}

function cutAt(text: string, stops: string): [string, string | undefined] {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (depth === 0 && stops.includes(c)) return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, undefined];
}

function addBoundNames(binding: string, names: Set<string>): void {
  const target = binding
    .trim()
    .replace(/^\.\.\./, '')
    .trim();
  const isObject = target.startsWith('{');
  if (!isObject && !target.startsWith('[')) {
    const name = target.match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (name !== undefined) names.add(name);
    return;
  }
  for (const element of topLevelParts(target.slice(1, -1))) {
    const [binding] = cutAt(element, '=');
    const [key, local] = isObject ? cutAt(binding, ':') : [binding, undefined];
    addBoundNames(local ?? key, names);
  }
}

function parameterNamesOf(argsBlock: string): Set<string> {
  const names = new Set<string>();
  for (const part of topLevelParts(argsBlock)) addBoundNames(cutAt(part, ':=?')[0], names);
  return names;
}

function withoutNames(constants: DeclaredConstants, names: ReadonlySet<string>): DeclaredConstants {
  return new Map([...constants].filter(([name]) => !names.has(name)));
}

function unreadableReadinessOptions(callText: string, where: string): Error {
  return new Error(
    `extractReadinessBudgets: cannot read the options of ${callText} at ${where}; the third ` +
      'argument must be an object literal of key: value pairs whose capMs, stallMs and pollMs ' +
      'are numeric literals',
  );
}

function readReadinessBudgets(
  options: string | undefined,
  callText: string,
  where: string,
): ReadinessBudgets {
  const read: ReadinessBudgets = {};
  if (options === undefined) return read;
  if (!options.startsWith('{') || findMatchingClose(options, 0) !== options.length - 1) {
    throw unreadableReadinessOptions(callText, where);
  }
  for (const property of topLevelParts(options.slice(1, -1))) {
    const pair = property.match(READINESS_OPTION_PROPERTY_RE);
    if (pair === null) throw unreadableReadinessOptions(callText, where);
    const [, key, value] = pair;
    if (!isReadinessBudgetKey(key)) continue;
    const literal = value.trim().match(NUMERIC_LITERAL_RE);
    if (literal === null) throw unreadableReadinessOptions(callText, where);
    read[key] = parseNumericLiteral(literal[1]);
  }
  return read;
}

export function extractReadinessBudgets(
  src: string,
  tier: ChargeTier = UNPACKAGED_CHARGE_TIER,
): number[] {
  return readinessBudgetsIn(src, tier, (at) => locatorFor(undefined)(lineNumberAt(src, at)));
}

function readinessBudgetsIn(
  src: string,
  tier: ChargeTier,
  whereAt: (at: number) => string,
): number[] {
  const budgets: number[] = [];
  for (const m of src.matchAll(READINESS_HELPER_CALL_RE)) {
    const callStart = m.index ?? 0;
    const openIdx = src.indexOf('(', callStart);
    if (openIdx === -1) continue;
    let depth = 1;
    let i = openIdx + 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    const args = src.slice(openIdx + 1, Math.max(openIdx + 1, i - 1));
    const read = readReadinessBudgets(
      topLevelParts(args)[2],
      src.slice(callStart, i),
      whereAt(callStart),
    );
    budgets.push(readinessGiveUpBoundMs({ path: tier.path, ...read }));
  }
  return budgets;
}

export function extractHelperBudgets(
  src: string,
  tier: ChargeTier = UNPACKAGED_CHARGE_TIER,
): HelperBudget[] {
  return helperBudgetsIn(
    src,
    tier,
    src.matchAll(FUNCTION_HEADER_RE),
    locatorFor(undefined),
    declaredConstantsOf(src),
  );
}

function helperBudgetsIn(
  src: string,
  tier: ChargeTier,
  headers: Iterable<RegExpMatchArray>,
  locate: (line: number) => string,
  constants: DeclaredConstants,
): HelperBudget[] {
  const helpers: HelperBudget[] = [];
  const code = stripCommentsAndStrings(src);
  for (const m of headers) {
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
    const argsBlock = code.slice(parenOpenIdx + 1, argEnd - 1);
    const bodyOpenIdx = functionBodyOpenAfter(code, argEnd);
    if (bodyOpenIdx === undefined) {
      throw new Error(
        `extractHelperBudgets: cannot find where the body of ${name} at ` +
          `${locate(lineNumberAt(src, parenOpenIdx))} begins after its return type`,
      );
    }
    if (bodyOpenIdx === -1) continue;
    const bodyCloseIdx = findMatchingClose(src, bodyOpenIdx);
    if (bodyCloseIdx === -1) continue;
    const body = stripCommentsAndStrings(src.slice(bodyOpenIdx + 1, bodyCloseIdx));

    const budgets = [
      ...chargesAfter(argsBlock, DEFAULT_TIMEOUT_ARG_RE, constants),
      ...chargesAfter(body, TIMEOUT_VALUE_RE, withoutNames(constants, parameterNamesOf(argsBlock))),
    ];
    if (LAUNCH_HELPER_CALL_RE.test(body)) {
      budgets.push(DEFAULT_LAUNCH_TIMEOUT_MS);
    }
    budgets.push(
      ...readinessBudgetsIn(body, tier, (at) => locate(lineNumberAt(src, bodyOpenIdx + 1 + at))),
    );
    const maxTimeoutMs = budgets.length > 0 ? Math.max(...budgets) : 0;
    if (maxTimeoutMs > 0) {
      helpers.push({ name, maxTimeoutMs });
    }
  }
  return helpers;
}

function evaluateArithmetic(
  text: string,
  constants: DeclaredConstants = new Map(),
): number | undefined {
  const tokens = text.match(ARITHMETIC_TOKEN_RE) ?? [];
  let at = 0;
  function factor(): number | undefined {
    const token: string | undefined = tokens[at];
    if (token === '(') {
      at += 1;
      const value = sum();
      if (value === undefined || tokens[at] !== ')') return undefined;
      at += 1;
      return value;
    }
    if (token === undefined) return undefined;
    const value = NUMERIC_LITERAL_RE.test(token)
      ? parseNumericLiteral(token)
      : constants.get(token);
    if (value !== undefined) at += 1;
    return value;
  }
  function product(): number | undefined {
    let value = factor();
    while (value !== undefined && tokens[at] === '*') {
      at += 1;
      const next = factor();
      value = next === undefined ? undefined : value * next;
    }
    return value;
  }
  function sum(): number | undefined {
    let value = product();
    while (value !== undefined && tokens[at] === '+') {
      at += 1;
      const next = product();
      value = next === undefined ? undefined : value + next;
    }
    return value;
  }
  const value = sum();
  return value !== undefined && at === tokens.length ? value : undefined;
}

export function extractTestEntries(
  src: string,
  helpers: HelperBudget[],
  tier: ChargeTier = UNPACKAGED_CHARGE_TIER,
): TestEntry[] {
  return testEntriesOf(
    src,
    src.matchAll(TEST_HEADER_RE),
    () => helpers,
    tier,
    locatorFor(undefined),
    declaredConstantsOf(src),
  );
}

function declarationStartOf(header: RegExpMatchArray): number {
  return (header.index ?? 0) + header[0].indexOf('test');
}

function callsTo(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*\\(`, 'g');
}

function testEntriesOf(
  src: string,
  headers: Iterable<RegExpMatchArray>,
  helpersCalledIn: (body: string) => readonly HelperBudget[],
  tier: ChargeTier,
  locate: (line: number) => string,
  constants: DeclaredConstants,
): TestEntry[] {
  const entries: TestEntry[] = [];
  for (const m of headers) {
    const testName = m[2];
    const headerStart = declarationStartOf(m);
    const lineNumber = lineNumberAt(src, headerStart);
    const arrowIdx = src.indexOf('=>', headerStart);
    if (arrowIdx === -1) continue;
    const bodyOpenIdx = src.indexOf('{', arrowIdx);
    if (bodyOpenIdx === -1) continue;
    const bodyCloseIdx = findMatchingClose(src, bodyOpenIdx);
    if (bodyCloseIdx === -1) continue;
    const body = src.slice(bodyOpenIdx + 1, bodyCloseIdx);

    const strippedForTimeouts = stripCommentsAndStrings(body);
    const directTimeoutsMs = chargesAfter(strippedForTimeouts, TIMEOUT_VALUE_RE, constants);
    directTimeoutsMs.push(
      ...readinessBudgetsIn(strippedForTimeouts, tier, (at) =>
        locate(lineNumberAt(src, bodyOpenIdx + 1 + at)),
      ),
    );
    const toPassBudgetsMs = chargesAfter(strippedForTimeouts, TOPASS_TIMEOUT_RE, constants);
    const literalOutersMs: number[] = [];
    const derivedOuterLines: number[] = [];
    for (const sm of strippedForTimeouts.matchAll(TEST_SET_TIMEOUT_RE)) {
      const outerAt = sm.index ?? 0;
      const line = lineNumberAt(src, bodyOpenIdx + 1 + outerAt);
      const argumentStart = outerAt + sm[0].length;
      let depth = 1;
      let argumentEnd = argumentStart;
      while (argumentEnd < strippedForTimeouts.length && depth > 0) {
        const c = strippedForTimeouts[argumentEnd];
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        argumentEnd += 1;
      }
      const argument = strippedForTimeouts.slice(argumentStart, argumentEnd - 1).trim();
      if (DERIVED_OUTER_RE.test(argument)) {
        derivedOuterLines.push(line);
        continue;
      }
      const outerMs = evaluateArithmetic(argument);
      if (outerMs === undefined) {
        throw new Error(
          `extractTestEntries: cannot read test.setTimeout(${argument}) at ${locate(line)}; a ` +
            'per-test outer must be numeric-literal arithmetic or exactly ' +
            'sumOfDeclaredBoundsMs(test.info())',
        );
      }
      literalOutersMs.push(outerMs);
    }
    const derivedOuterLine = derivedOuterLines[0];
    if (derivedOuterLine !== undefined && derivedOuterLines.length + literalOutersMs.length > 1) {
      throw new Error(
        `extractTestEntries: the sumOfDeclaredBoundsMs(test.info()) outer at ` +
          `${locate(derivedOuterLine)} must be the only test.setTimeout in its test`,
      );
    }
    const strippedBody = stripCommentsAndStrings(body);
    const helperCallNames: string[] = [];
    const tracedHelperBudgetsMs: number[] = [];
    for (const helper of helpersCalledIn(strippedBody)) {
      for (const _cm of strippedBody.matchAll(callsTo(helper.name))) {
        helperCallNames.push(helper.name);
        tracedHelperBudgetsMs.push(helper.maxTimeoutMs);
      }
    }
    const cumulativeMs =
      directTimeoutsMs.reduce((a, b) => a + b, 0) +
      tracedHelperBudgetsMs.reduce((a, b) => a + b, 0);
    const outer: PerTestOuter =
      derivedOuterLine !== undefined
        ? { perTestTimeoutMs: cumulativeMs, perTestTimeoutSource: 'sum-of-declared-bounds' }
        : literalOutersMs.length > 0
          ? { perTestTimeoutMs: Math.max(...literalOutersMs), perTestTimeoutSource: 'literal' }
          : { perTestTimeoutMs: null, perTestTimeoutSource: null };
    entries.push({
      testName,
      lineNumber,
      ...outer,
      directTimeoutsMs,
      helperCallNames,
      tracedHelperBudgetsMs,
      cumulativeMs,
      toPassBudgetsMs,
      bodyRange: [bodyOpenIdx, bodyCloseIdx],
    });
  }
  return entries;
}

export function parseTestFile(
  filePath: string,
  tier: ChargeTier = UNPACKAGED_CHARGE_TIER,
): FileAnalysis {
  const src = readFileSync(filePath, 'utf8');
  const locate = locatorFor(filePath);
  const constants = declaredConstantsOf(src, filePath);
  const helpers = helperBudgetsIn(src, tier, src.matchAll(FUNCTION_HEADER_RE), locate, constants);
  const tests = testEntriesOf(
    src,
    src.matchAll(TEST_HEADER_RE),
    () => helpers,
    tier,
    locate,
    constants,
  );
  return { filePath, helpers, tests, looseSetTimeoutLines: findLooseSetTimeouts(src, tests) };
}

function findLooseSetTimeouts(src: string, tests: TestEntry[]): number[] {
  const stripped = stripCommentsAndStrings(src);
  const bodies = tests.map((t) => t.bodyRange);
  const lines: number[] = [];
  for (const m of stripped.matchAll(TEST_SET_TIMEOUT_RE)) {
    const at = m.index ?? 0;
    if (bodies.some(([open, close]) => at > open && at < close)) continue;
    lines.push(lineNumberAt(src, at));
  }
  return lines;
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
  const derivedLocal = raw.match(
    /^process\.env\.CI\s*\?\s*(\d+(?:_\d+)*)\s*:\s*ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS$/,
  );
  if (derivedLocal) {
    return {
      ci: parseNumericLiteral(derivedLocal[1]),
      local: ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS,
      raw,
    };
  }
  throw new Error(
    `parsePlaywrightConfigTimeout: unsupported \`timeout:\` shape in ${configPath} — got "${raw}"`,
  );
}

export function sumOfDeclaredBoundsMs(
  test: { file: string; line: number; timeout?: number },
  path: ReadinessPath = readinessPathOf(resolveDesktopTarget().mode),
): number {
  const src = readFileSync(test.file, 'utf8');
  const tier: ChargeTier = { path };
  const locate = locatorFor(test.file);
  const constants = declaredConstantsOf(src, test.file);
  const entry = testEntriesOf(
    src,
    [...src.matchAll(TEST_HEADER_RE)].filter(
      (header) => lineNumberAt(src, declarationStartOf(header)) === test.line,
    ),
    (body) =>
      helperBudgetsIn(
        src,
        tier,
        [...src.matchAll(FUNCTION_HEADER_RE)].filter((header) => callsTo(header[1]).test(body)),
        locate,
        constants,
      ),
    tier,
    locate,
    constants,
  ).at(0);
  if (entry === undefined) {
    throw new Error(`sumOfDeclaredBoundsMs: no test is declared at ${test.file}:${test.line}`);
  }
  if (test.timeout === undefined) return entry.cumulativeMs;
  return test.timeout === 0 ? 0 : Math.max(test.timeout, entry.cumulativeMs);
}

export function perTestBudgetMs(
  entry: TestEntry,
  scoring: { filePath: string; path: ReadinessPath; configCiMs: number },
): { budgetMs: number; source: 'literal' | 'sum-of-declared-bounds' | 'config-ci' } {
  switch (entry.perTestTimeoutSource) {
    case 'sum-of-declared-bounds':
      return {
        budgetMs: sumOfDeclaredBoundsMs(
          { file: scoring.filePath, line: entry.lineNumber },
          scoring.path,
        ),
        source: 'sum-of-declared-bounds',
      };
    case 'literal':
      return { budgetMs: entry.perTestTimeoutMs, source: 'literal' };
    case null:
      return { budgetMs: scoring.configCiMs, source: 'config-ci' };
  }
}
