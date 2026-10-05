import type { Readable, Writable } from 'node:stream';
import { gitCredentialHostKey } from '@inkeep/open-knowledge-core';
import type { Logger as PinoLoggerInstance } from 'pino';
import type { TokenStore, TokenStoreDiagnostics } from '../../auth/token-store.ts';

export type KeychainReadInfo = Parameters<NonNullable<TokenStoreDiagnostics['onKeychainRead']>>[0];

export interface CredentialGetLogContext {
  log?: PinoLoggerInstance;
  getDiag?: () => KeychainReadInfo | undefined;
}

export async function handleCredentialGet(
  input: Readable,
  output: Writable,
  tokenStore: TokenStore,
  ctx?: CredentialGetLogContext,
): Promise<number> {
  const text = await readAll(input);
  const attrs = parseCredentialInput(text);
  const host = attrs.host ?? '';

  const safeLine = (s: string) => s.replace(/[\r\n]/g, '');

  if (!host) {
    ctx?.log?.warn(
      { outcome: 'no-host', backend: tokenStore.backend },
      '[auth] git-credential get',
    );
    return 1;
  }

  if (attrs.protocol !== undefined && attrs.protocol !== 'https') {
    ctx?.log?.warn(
      { host, protocol: attrs.protocol, outcome: 'insecure-protocol', backend: tokenStore.backend },
      '[auth] git-credential get',
    );
    return 1;
  }

  const key = gitCredentialHostKey(host, attrs.protocol);
  const relayToken = process.env.OK_GH_TOKEN;
  const relayTokenHost = process.env.OK_GH_TOKEN_HOST;
  if (relayToken && relayTokenHost && gitCredentialHostKey(relayTokenHost) === key) {
    ctx?.log?.debug(
      {
        host,
        outcome: 'gh-env-token',
        backend: tokenStore.backend,
        relayLogin: process.env.OK_GH_TOKEN_LOGIN,
      },
      '[auth] git-credential get',
    );
    output.write(`username=x-access-token\npassword=${safeLine(relayToken)}\n`);
    return 0;
  }

  const entry = (await tokenStore.get(key)) ?? (key === host ? null : await tokenStore.get(host));
  const diag = ctx?.getDiag?.();
  const outcome = entry != null ? 'found' : (diag?.kind ?? 'absent');
  if (ctx?.log) {
    const fields = {
      host,
      outcome,
      backend: tokenStore.backend,
      ...(diag?.error ? { keychainError: diag.error } : {}),
    };
    if (outcome === 'found') ctx.log.debug(fields, '[auth] git-credential get');
    else ctx.log.warn(fields, '[auth] git-credential get');
  }

  if (entry == null) return 1;

  output.write(`username=${safeLine(entry.login)}\npassword=${safeLine(entry.token)}\n`);
  return 0;
}

function parseCredentialInput(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}
