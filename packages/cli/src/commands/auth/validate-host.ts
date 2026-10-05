import {
  gitCredentialHostKey,
  isGitHubHost,
  normalizeGitHostname,
  okUserHomeDisplayPath,
} from '@inkeep/open-knowledge-core';
import {
  findEnclosingProjectRoot,
  readDeclaredGitHubHosts,
  readOriginCredentialHost,
  resolveGitHubAuthHost,
} from '@inkeep/open-knowledge-server';
import { error as errorColor } from '../../ui/colors.ts';

function authProjectDir(): string {
  const cwd = process.cwd();
  return findEnclosingProjectRoot(cwd)?.rootPath ?? cwd;
}

function declarationRemedy(host: string): string {
  return `${okUserHomeDisplayPath('global.yml')}:\n\n  git:\n    hosts:\n      ${host}:\n        provider: github\n`;
}

export function tokenCommandLine(host: string): string {
  return `  ok auth token --host ${host} --username <username>`;
}

function tokenRemedy(host: string): string {
  return `If ${host} is not a GitHub host, store an access token for git with:\n\n${tokenCommandLine(host)}\n`;
}

function explicitGitHubHostRejection(host: string): string {
  return (
    `${errorColor('Error:')} ${host} is not a known GitHub host.\n` +
    `To use a GitHub Enterprise Server host, declare it in ${declarationRemedy(host)}\n` +
    tokenRemedy(host)
  );
}

export function isDeclaredGitHubHost(host: string): boolean {
  return isGitHubHost(host, readDeclaredGitHubHosts());
}

export function gitHubHostRejection(host: string): string | null {
  return isDeclaredGitHubHost(host)
    ? null
    : explicitGitHubHostRejection(normalizeGitHostname(host));
}

export function validateGitHubHost(host: string): void {
  const rejection = gitHubHostRejection(host);
  if (rejection === null) return;
  process.stderr.write(rejection);
  process.exit(1);
}

function nonGitHubOriginRejection(
  credentialHost: string | null,
  offerDeclaration: boolean,
): string {
  if (credentialHost === null) {
    return (
      `${errorColor('Error:')} Cannot determine a GitHub hostname from this project's git remote.\n` +
      'Pass --host <hostname> to target a GitHub host explicitly.\n'
    );
  }
  const host = normalizeGitHostname(credentialHost);
  const declaration = offerDeclaration
    ? `, or, if ${host} runs GitHub Enterprise Server, declare it in ${declarationRemedy(host)}\n`
    : '.\n';
  return (
    `${errorColor('Error:')} this project's git remote is ${host}, which is not a GitHub host, so GitHub sign-in does not apply here.\n` +
    `Pass --host <hostname> to target a GitHub host explicitly${declaration}` +
    tokenRemedy(credentialHost)
  );
}

export type StatusHost = { kind: 'github'; host: string } | { kind: 'other'; host: string };

export function resolveStatusHost(
  explicitHost: string | undefined,
  projectDir: string = authProjectDir(),
): StatusHost {
  if (explicitHost !== undefined) {
    return isDeclaredGitHubHost(explicitHost)
      ? { kind: 'github', host: explicitHost }
      : { kind: 'other', host: gitCredentialHostKey(explicitHost) };
  }
  const result = resolveGitHubAuthHost(projectDir);
  if (result.kind === 'ok') return { kind: 'github', host: result.host };
  const tokenHost = readOriginCredentialHost(projectDir) ?? result.host;
  if (tokenHost !== null) return { kind: 'other', host: tokenHost };
  process.stderr.write(nonGitHubOriginRejection(null, false));
  process.exit(1);
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
      : nonGitHubOriginRejection(
          readOriginCredentialHost(projectDir) ?? result.host,
          result.host !== null,
        ),
  );
  process.exit(1);
}

export function resolveSignoutHost(
  explicitHost: string | undefined,
  projectDir: string = authProjectDir(),
): string {
  if (explicitHost !== undefined) {
    return isDeclaredGitHubHost(explicitHost) ? explicitHost : gitCredentialHostKey(explicitHost);
  }
  const result = resolveGitHubAuthHost(projectDir);
  if (result.kind === 'ok') return result.host;
  const credentialHost = readOriginCredentialHost(projectDir) ?? result.host;
  const lead =
    credentialHost === null
      ? `Cannot determine a hostname from this project's git remote.`
      : `This project's git remote is ${normalizeGitHostname(credentialHost)}, which is not a known GitHub host.`;
  process.stderr.write(
    `${errorColor('Error:')} ${lead}\n` +
      `Run ok auth signout --host ${credentialHost ?? '<hostname>'} to remove stored local credentials. No provider declaration is required.\n`,
  );
  process.exit(1);
}
