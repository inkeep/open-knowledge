import type * as childProcess from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

export function guardAbsoluteGhLaunches(original: typeof childProcess): typeof childProcess {
  const check = (command: unknown): void => {
    if (
      typeof command === 'string' &&
      isAbsolute(command) &&
      /^gh(?:\.exe)?$/i.test(basename(command))
    ) {
      throw new Error(`Unexpected absolute gh invocation: ${command}`);
    }
  };
  const guardedExecFile = ((...args: unknown[]) => {
    check(args[0]);
    return Reflect.apply(original.execFile, original, args);
  }) as typeof original.execFile;
  const nativePromisified = Reflect.get(original.execFile, promisify.custom);
  if (typeof nativePromisified === 'function') {
    Object.defineProperty(guardedExecFile, promisify.custom, {
      value: (...args: unknown[]) => {
        check(args[0]);
        return Reflect.apply(nativePromisified, original.execFile, args);
      },
    });
  }
  return {
    ...original,
    execFile: guardedExecFile,
    spawn: ((...args: unknown[]) => {
      check(args[0]);
      return Reflect.apply(original.spawn, original, args);
    }) as typeof original.spawn,
  };
}
