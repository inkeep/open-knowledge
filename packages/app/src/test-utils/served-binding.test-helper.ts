import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ServedRead {
  readonly specifier: string;
  readonly member: string;
  readonly reader: string;
}

interface ServedBindingLog {
  serve<T extends object>(specifier: string, exports: T): T;
  mark(): number;
  readersOf(specifier: string, member: string, since?: number): string[];
}

const HELPER_FILE = fileURLToPath(import.meta.url);
const APP_SOURCE_ROOT = dirname(dirname(HELPER_FILE));
const UNKNOWN_READER = '<unknown>';
const STACK_DEPTH = 64;

function frameLocation(frame: string): string | undefined {
  const trimmed = frame.trim();
  if (!trimmed.startsWith('at ')) return undefined;
  const inParens = /\((.+)\)$/.exec(trimmed);
  const location = inParens?.[1] ?? trimmed.slice('at '.length);
  const file = location.replace(/:\d+:\d+$/, '');
  if (file === location) return undefined;
  const path = file.startsWith('file://') ? fileURLToPath(file) : file;
  return isAbsolute(path) ? resolve(path) : undefined;
}

function readerFrom(stack: string | undefined): string {
  for (const frame of (stack ?? '').split('\n').slice(1)) {
    const file = frameLocation(frame);
    if (file === undefined || file === HELPER_FILE) continue;
    if (file.split(/[\\/]/).includes('node_modules')) continue;
    return relative(APP_SOURCE_ROOT, file).split(sep).join('/');
  }
  return UNKNOWN_READER;
}

export function createServedBindingLog(): ServedBindingLog {
  const log: ServedRead[] = [];
  return {
    serve<T extends object>(specifier: string, exports: T): T {
      const served = {};
      for (const member of Object.keys(exports)) {
        Object.defineProperty(served, member, {
          enumerable: true,
          get() {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = STACK_DEPTH;
            const stack = new Error().stack;
            Error.stackTraceLimit = limit;
            log.push({ specifier, member, reader: readerFrom(stack) });
            return Reflect.get(exports, member);
          },
        });
      }
      return served as T;
    },
    mark() {
      return log.length;
    },
    readersOf(specifier, member, since = 0) {
      const readers = log
        .slice(since)
        .filter((read) => read.specifier === specifier && read.member === member)
        .map((read) => read.reader);
      return [...new Set(readers)].sort();
    },
  };
}
