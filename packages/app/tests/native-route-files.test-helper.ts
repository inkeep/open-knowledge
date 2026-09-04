import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const HANDLER_RUN_END_NEEDLES = [
  '\n  const routes:',
  '\n  const routes =',
  '\n  return createApiRouteGroup(',
] as const;

export function extractRouteHandlerNames(text: string): string[] {
  return [...text.matchAll(/'\/api\/[^']*':\s*(handle\w+)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

export function listNativeRouteFiles(serverSrcRoot: string): string[] {
  return readdirSync(join(serverSrcRoot, 'http'))
    .filter((entry) => entry.endsWith('-routes.ts') && !entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => `http/${entry}`);
}
