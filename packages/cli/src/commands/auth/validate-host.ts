import { isGitHubHost, normalizeGitHostname } from '@inkeep/open-knowledge-core';
import {
  findEnclosingProjectRoot,
  readDeclaredGitHubHosts,
  resolveGitHubAuthHost,
} from '@inkeep/open-knowledge-server';
import { error as errorColor } from '../../ui/colors.ts';

function authProjectDir(): string {
  const cwd = process.cwd();
  return findEnclosingProjectRoot(cwd)?.rootPath ?? cwd;
}

function declarationRemedy(host: string): string {
  return `~/.ok/global.yml:\n\n  git:\n    hosts:\n      ${host}:\n        provider: github\n`;
}

function explicitGitHubHostRejection(host: string): string {
  return (
    `${errorColor('Error:')} ${host} is not a known GitHub host.\n` +
    `To use a GitHub Enterprise Server host, declare it in ${declarationRemedy(host)}`
  );
}

export function gitHubHostRejection(host: string): string | null {
  return isGitHubHost(host, readDeclaredGitHubHosts())
    ? null
    : explicitGitHubHostRejection(normalizeGitHostname(host));
}

export function validateGitHubHost(host: string): void {
  const rejection = gitHubHostRejection(host);
  if (rejection === null) return;
  process.stderr.write(rejection);
  process.exit(1);
}

function nonGitHubOriginRejection(originHost: string | null): string {
  const lead =
    originHost === null
      ? `${errorColor('Error:')} Cannot determine a GitHub hostname from this project's git remote.\n`
      : `${errorColor('Error:')} this project's git remote is ${originHost}, which is not a GitHub host, so GitHub sign-in does not apply here.\n`;
  const remedy =
    originHost === null
      ? 'Pass --host <hostname> to target a GitHub host explicitly.\n'
      : `Pass --host <hostname> to target a GitHub host explicitly, or, if ${originHost} runs GitHub Enterprise Server, declare it in ${declarationRemedy(originHost)}`;
  return lead + remedy;
}

export function resolveAuthHost(
  explicitHost: string | undefined,
  projectDir: string = authProjectDir(),
): string {
  const result = resolveGitHubAuthHost(projectDir, explicitHost);
  if (result.kind === 'ok') return result.host;
  process.stderr.write(
    result.kind === 'rejected-explicit'
      ? explicitGitHubHostRejection(result.host)
      : nonGitHubOriginRejection(result.host),
  );
  process.exit(1);
}

export function resolveSignoutHost(
  explicitHost: string | undefined,
  projectDir: string = authProjectDir(),
): string {
  if (explicitHost !== undefined) return explicitHost;
  const result = resolveGitHubAuthHost(projectDir);
  if (result.kind === 'ok') return result.host;
  const lead =
    result.host === null
      ? `Cannot determine a hostname from this project's git remote.`
      : `This project's git remote is ${result.host}, which is not a known GitHub host.`;
  process.stderr.write(
    `${errorColor('Error:')} ${lead}\n` +
      `Run ok auth signout --host ${result.host ?? '<hostname>'} to remove stored local credentials. No provider declaration is required.\n`,
  );
  process.exit(1);
}
