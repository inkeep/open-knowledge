import { hostFacts } from './file-bridge';

export const sep = '/';
export const delimiter = ':';

export function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}

export function normalize(path: string): string {
  const absolute = isAbsolute(path);
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') segments.push(segment);
    else if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
    else if (!absolute) segments.push('..');
  }
  const joined = segments.join('/');
  if (absolute) return `/${joined}`;
  return joined === '' ? '.' : joined;
}

export function join(...paths: string[]): string {
  return normalize(paths.filter((path) => path !== '').join('/'));
}

export function resolve(...paths: string[]): string {
  let resolved = '';
  for (const path of [...paths].reverse()) {
    if (path === '') continue;
    resolved = resolved === '' ? path : `${path}/${resolved}`;
    if (isAbsolute(path)) break;
  }
  return normalize(isAbsolute(resolved) ? resolved : `${hostFacts().cwd}/${resolved}`);
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf('/');
  if (index === -1) return '.';
  return index === 0 ? '/' : normalized.slice(0, index);
}

export function basename(path: string, suffix?: string): string {
  const base = normalize(path).split('/').at(-1) ?? '';
  return suffix !== undefined && base.endsWith(suffix) && base !== suffix
    ? base.slice(0, -suffix.length)
    : base;
}

export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

export function relative(from: string, to: string): string {
  const fromSegments = resolve(from).split('/').filter(Boolean);
  const toSegments = resolve(to).split('/').filter(Boolean);
  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared += 1;
  }
  return [...fromSegments.slice(shared).map(() => '..'), ...toSegments.slice(shared)].join('/');
}

export const posix = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
};

export default posix;
