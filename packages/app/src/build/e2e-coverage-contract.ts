import { isAbsolute, join, relative, sep } from 'node:path';

const E2E_COVERAGE_DIR_ENV = 'OK_E2E_COVERAGE_DIR';
export const E2E_COVERAGE_PATH = '/__ok-e2e-coverage';

interface CoverageRange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly count: number;
}

interface FunctionCoverage {
  readonly functionName: string;
  readonly ranges: readonly CoverageRange[];
}

export interface ScriptCoverage {
  readonly url: string;
  readonly functions: readonly FunctionCoverage[];
}

export interface SourceRegion {
  readonly start: number;
  readonly end: number;
  readonly path: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function e2eCoverageDir(env: Env): string | undefined {
  const dir = env[E2E_COVERAGE_DIR_ENV];
  return dir === undefined || dir === '' ? undefined : dir;
}

function isModuleBody(fn: FunctionCoverage): boolean {
  return fn.functionName === '' && fn.ranges[0]?.startOffset === 0;
}

export function executedOffsets(script: ScriptCoverage): number[] {
  const offsets: number[] = [];
  for (const fn of script.functions) {
    const whole = fn.ranges[0];
    if (whole === undefined || whole.count <= 0 || isModuleBody(fn)) continue;
    offsets.push(whole.startOffset);
  }
  return offsets;
}

const UNRECORDED_SEGMENTS = new Set(['node_modules', 'dist', '.vite', '.vite-temp']);
const UNRECORDED_PREFIXES = ['packages/app/tests/', 'test-support/'];
const TEST_MODULE = /\.(test|test-helper|e2e|dom\.test|browser\.test)\.[cm]?[jt]sx?$/;

export function recordableSource(absPath: string, okRoot: string): string | undefined {
  const within = relative(okRoot, absPath).split(sep).join('/');
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return undefined;
  if (within.split('/').some((segment) => UNRECORDED_SEGMENTS.has(segment))) return undefined;
  if (UNRECORDED_PREFIXES.some((prefix) => within.startsWith(prefix))) return undefined;
  if (TEST_MODULE.test(within)) return undefined;
  return within;
}

export function browserScriptFile(url: string, appDir: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (path.startsWith('/@fs/')) return path.slice('/@fs'.length);
  if (path.startsWith('/@') || path.startsWith('/node_modules/') || path === '/') return undefined;
  return join(appDir, path);
}

const REGION_OPEN = /^\/\/#region (.+)$/;
const REGION_CLOSE = /^\/\/#endregion\b/;

export function sourceRegions(text: string): SourceRegion[] {
  const regions: SourceRegion[] = [];
  let open: { start: number; path: string } | undefined;
  let offset = 0;
  for (const line of text.split('\n')) {
    const opening = REGION_OPEN.exec(line);
    if (opening !== null) {
      if (open !== undefined) regions.push({ ...open, end: offset });
      open = { start: offset, path: opening[1]?.trim() ?? '' };
    } else if (REGION_CLOSE.test(line) && open !== undefined) {
      regions.push({ ...open, end: offset + line.length });
      open = undefined;
    }
    offset += line.length + 1;
  }
  if (open !== undefined) regions.push({ ...open, end: text.length });
  return regions;
}

export function regionAt(
  regions: readonly SourceRegion[],
  offset: number,
): SourceRegion | undefined {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const region = regions[mid];
    if (region === undefined) return undefined;
    if (offset < region.start) high = mid - 1;
    else if (offset >= region.end) low = mid + 1;
    else return region;
  }
  return undefined;
}

export function serverScriptFiles(
  script: ScriptCoverage,
  scriptFile: string,
  regions: readonly SourceRegion[],
  packageDir: string,
): string[] {
  const offsets = executedOffsets(script);
  if (offsets.length === 0) return [];
  if (regions.length === 0) return [scriptFile];
  const files = new Set<string>();
  for (const offset of offsets) {
    const region = regionAt(regions, offset);
    if (region !== undefined && region.path !== '') files.add(join(packageDir, region.path));
  }
  return [...files];
}
