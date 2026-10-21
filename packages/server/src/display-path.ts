import { relative } from 'node:path';
import { isWithinDir, toPosix } from './path-utils.ts';

export function displayPathFor(abs: string, projectDir: string | null, home: string): string {
  if (projectDir !== null && isWithinDir(abs, projectDir))
    return toPosix(relative(projectDir, abs));
  if (isWithinDir(abs, home)) return `~/${toPosix(relative(home, abs))}`;
  return toPosix(abs);
}
