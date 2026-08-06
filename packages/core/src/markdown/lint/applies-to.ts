import picomatch from 'picomatch';
import { SUPPORTED_DOC_EXTENSIONS } from '../../constants/doc-extensions.ts';

type PathMatcher = (path: string) => boolean;

type SuspiciousAppliesToReason = 'trailing-slash' | 'leading-slash' | 'doc-extension';

interface SuspiciousAppliesToPattern {
  pattern: string;
  reason: SuspiciousAppliesToReason;
}

interface InvalidAppliesToPattern {
  pattern: string;
  detail: string;
}

export interface CompiledAppliesTo {
  invalidPatterns: InvalidAppliesToPattern[];
  suspiciousPatterns: SuspiciousAppliesToPattern[];
  matches(docName: string | undefined): boolean;
}

function normalizeDocPath(docName: string): string {
  let path = docName.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  const lower = path.toLowerCase();
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return path.slice(0, -ext.length);
  }
  return path;
}

export function compileAppliesTo(appliesTo: string | string[] | undefined): CompiledAppliesTo {
  const raw = appliesTo === undefined ? [] : Array.isArray(appliesTo) ? appliesTo : [appliesTo];
  const authored = raw.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);

  const invalidPatterns: InvalidAppliesToPattern[] = [];
  const suspiciousPatterns: SuspiciousAppliesToPattern[] = [];
  const positiveMatchers: PathMatcher[] = [];
  const negationMatchers: PathMatcher[] = [];
  let authoredPositiveCount = 0;

  for (const pattern of authored) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (!negated) authoredPositiveCount += 1;
    if (body.length === 0) {
      invalidPatterns.push({ pattern, detail: 'empty pattern' });
      continue;
    }
    try {
      const matcher = picomatch(body, { dot: true, strictBrackets: true });
      (negated ? negationMatchers : positiveMatchers).push(matcher);
    } catch (err) {
      invalidPatterns.push({
        pattern,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (body.endsWith('/')) {
      suspiciousPatterns.push({ pattern, reason: 'trailing-slash' });
    } else if (body.startsWith('/')) {
      suspiciousPatterns.push({ pattern, reason: 'leading-slash' });
    } else {
      const lower = body.toLowerCase();
      if (SUPPORTED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        suspiciousPatterns.push({ pattern, reason: 'doc-extension' });
      }
    }
  }

  const implicitAll = authoredPositiveCount === 0;

  return {
    invalidPatterns,
    suspiciousPatterns,
    matches(docName) {
      if (docName === undefined || docName === '') return false;
      const path = normalizeDocPath(docName);
      if (path === '') return false;
      const positive = implicitAll || positiveMatchers.some((matcher) => matcher(path));
      if (!positive) return false;
      return !negationMatchers.some((matcher) => matcher(path));
    },
  };
}

export function findZeroMatchAppliesToPatterns(
  appliesTo: string | string[] | undefined,
  docPaths: readonly string[],
): string[] {
  if (docPaths.length === 0) return [];
  const raw = appliesTo === undefined ? [] : Array.isArray(appliesTo) ? appliesTo : [appliesTo];
  const authored = raw.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  const normalized = docPaths.map(normalizeDocPath).filter((path) => path !== '');
  const unmatched: string[] = [];
  for (const pattern of authored) {
    const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    if (body.length === 0) continue;
    let matcher: PathMatcher;
    try {
      matcher = picomatch(body, { dot: true, strictBrackets: true });
    } catch {
      continue;
    }
    if (!normalized.some((path) => matcher(path))) unmatched.push(pattern);
  }
  return unmatched;
}

export type AppliesToPatternSummary =
  | { kind: 'everything' }
  | { kind: 'folder-recursive'; folder: string }
  | { kind: 'folder-direct'; folder: string }
  | { kind: 'folder-anywhere'; folder: string }
  | { kind: 'folder-recursive-nested'; root: string; folder: string }
  | { kind: 'exact'; target: string }
  | { kind: 'name-anywhere'; name: string }
  | { kind: 'matches-nothing'; pattern: string }
  | { kind: 'invalid'; pattern: string }
  | { kind: 'pattern'; pattern: string };

export interface AppliesToSummary {
  includes: AppliesToPatternSummary[];
  excludes: AppliesToPatternSummary[];
}

const GLOB_CHARS_RE = /[*?[\]{}()+@!|]/;

function expandSimpleBraces(body: string): string[] | null {
  const open = body.indexOf('{');
  if (open === -1) return null;
  const close = body.indexOf('}', open);
  if (close === -1) return null;
  if (body.indexOf('{', open + 1) !== -1 || body.indexOf('}', close + 1) !== -1) return null;
  const alternatives = body.slice(open + 1, close).split(',');
  if (alternatives.length < 2) return null;
  if (alternatives.some((alt) => alt.trim() === '' || GLOB_CHARS_RE.test(alt))) return null;
  return alternatives.map((alt) => body.slice(0, open) + alt + body.slice(close + 1));
}

function classifyBody(body: string): AppliesToPatternSummary {
  if (body.endsWith('/') || body.startsWith('/')) {
    return { kind: 'matches-nothing', pattern: body };
  }
  try {
    picomatch(body, { dot: true, strictBrackets: true });
  } catch {
    return { kind: 'invalid', pattern: body };
  }
  if (body === '**' || body === '**/*') return { kind: 'everything' };
  {
    const anywhere = body.match(/^\*\*\/(.+)\/\*\*$/);
    const anywhereFolder = anywhere?.[1];
    if (anywhereFolder !== undefined && !GLOB_CHARS_RE.test(anywhereFolder)) {
      return { kind: 'folder-anywhere', folder: anywhereFolder };
    }
    const nested = body.match(/^(.+)\/\*\*\/(.+)\/\*\*$/);
    const nestedRoot = nested?.[1];
    const nestedFolder = nested?.[2];
    if (
      nestedRoot !== undefined &&
      nestedFolder !== undefined &&
      !GLOB_CHARS_RE.test(nestedRoot) &&
      !GLOB_CHARS_RE.test(nestedFolder)
    ) {
      return { kind: 'folder-recursive-nested', root: nestedRoot, folder: nestedFolder };
    }
  }
  for (const suffix of ['/**/*', '/**']) {
    if (body.endsWith(suffix)) {
      const folder = body.slice(0, -suffix.length);
      if (folder.length > 0 && !GLOB_CHARS_RE.test(folder)) {
        return { kind: 'folder-recursive', folder };
      }
    }
  }
  if (body.endsWith('/*')) {
    const folder = body.slice(0, -2);
    if (folder.length > 0 && !GLOB_CHARS_RE.test(folder)) {
      return { kind: 'folder-direct', folder };
    }
  }
  if (body.startsWith('**/')) {
    const name = body.slice(3);
    if (name.length > 0 && !name.includes('/') && !GLOB_CHARS_RE.test(name)) {
      return { kind: 'name-anywhere', name };
    }
  }
  if (!GLOB_CHARS_RE.test(body)) return { kind: 'exact', target: body };
  return { kind: 'pattern', pattern: body };
}

function classifyPattern(body: string): AppliesToPatternSummary[] {
  const direct = classifyBody(body);
  if (direct.kind !== 'pattern') return [direct];
  const variants = expandSimpleBraces(body);
  if (variants !== null) {
    const classified = variants.map(classifyBody);
    if (classified.every((c) => c.kind !== 'pattern')) return classified;
  }
  return [direct];
}

export function summarizeAppliesTo(appliesTo: string | string[] | undefined): AppliesToSummary {
  const raw = appliesTo === undefined ? [] : Array.isArray(appliesTo) ? appliesTo : [appliesTo];
  const authored = raw.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  const includes: AppliesToPatternSummary[] = [];
  const excludes: AppliesToPatternSummary[] = [];
  for (const pattern of authored) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (body.length === 0) continue;
    (negated ? excludes : includes).push(...classifyPattern(body));
  }
  return { includes, excludes };
}
