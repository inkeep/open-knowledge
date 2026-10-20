import type { Stats } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createAppShellPolicies } from '@inkeep/open-knowledge-core/server';
import { getLogger } from '../logger.ts';

export function createShellHeaderSetter(distDir: string) {
  const policyFor = createAppShellPolicies(distDir, ({ err, root, file }, message) =>
    getLogger('shell-csp').warn({ err, root, file }, message),
  );
  return (res: ServerResponse, _pathname: string, stats: Stats, file: string): void => {
    const policy = policyFor({ file, stats });
    if (policy !== undefined) res.setHeader('Content-Security-Policy', policy);
  };
}
