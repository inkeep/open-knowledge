import type { Readable, Writable } from 'node:stream';
import { flushFileLogger } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import type { Logger as PinoLoggerInstance } from 'pino';
import type { TokenStore, TokenStoreDiagnostics } from '../../auth/token-store.ts';

/**
 * Result of the keychain read for the requested host, captured via
 * `TokenStoreDiagnostics`. Derived from the callback's parameter so the two
 * shapes can't drift (a new `kind` added there flows here automatically).
 */
type KeychainReadInfo = Parameters<NonNullable<TokenStoreDiagnostics['onKeychainRead']>>[0];

/**
 * Optional logging context for {@link handleCredentialGet}. git invokes this
 * helper on every fetch/push (~hundreds of times a day), so the outcome is
 * logged at `debug` on the hit path (silent at the default `info` level) and
 * at `warn` only on a miss — the anomaly that precedes a sync auth failure.
 * `getDiag` lets the caller surface whether a `null` lookup was a genuine
 * absence or a keychain read error, which the credential value alone hides.
 */
export interface CredentialGetLogContext {
  log?: PinoLoggerInstance;
  getDiag?: () => KeychainReadInfo | undefined;
}

/**
 * Core git credential-helper get logic.
 *
 * Reads key=value pairs from `input` until blank line or EOF, looks up
 * credentials in `tokenStore` by hostname, and writes the result to `output`.
 *
 * Returns 0 on success, 1 if no credentials found.
 */
export async function handleCredentialGet(
  input: Readable,
  output: Writable,
  tokenStore: TokenStore,
  ctx?: CredentialGetLogContext,
): Promise<number> {
  const text = await readAll(input);
  const attrs = parseCredentialInput(text);
  const host = attrs.host ?? '';

  // Git's credential protocol is newline-delimited `key=value`. If a value
  // contained CR/LF it could inject arbitrary protocol fields such as
  // `\nurl=http://evil\npassword=stolen`. Strip them before writing. Applies to
  // both the relayed gh token and the stored entry below.
  const safeLine = (s: string) => s.replace(/[\r\n]/g, '');

  if (!host) {
    ctx?.log?.warn(
      { outcome: 'no-host', backend: tokenStore.backend },
      '[auth] git-credential get',
    );
    return 1;
  }

  // Tier A relay: a gh token resolved by the server process (where `gh` is
  // reachable) and passed through the otherwise-stripped git env. Preferred
  // over the stored token to match `resolveAuth`'s gh-first ordering, so sync
  // and clone authenticate via the same source. Host-scoped: a github.com token
  // must not be handed to a GHES remote. `x-access-token` is GitHub's
  // conventional username for token-as-password auth; the username is ignored
  // for OAuth/PAT tokens but must be non-empty.
  const relayToken = process.env.OK_GH_TOKEN;
  const relayTokenHost = process.env.OK_GH_TOKEN_HOST;
  if (relayToken && relayTokenHost === host) {
    ctx?.log?.debug(
      { host, outcome: 'gh-env-token', backend: tokenStore.backend },
      '[auth] git-credential get',
    );
    output.write(`username=x-access-token\npassword=${safeLine(relayToken)}\n`);
    return 0;
  }

  const entry = await tokenStore.get(host);
  const diag = ctx?.getDiag?.();
  const outcome = entry != null ? 'found' : (diag?.kind ?? 'absent');
  if (ctx?.log) {
    const fields = {
      host,
      outcome,
      backend: tokenStore.backend,
      ...(diag?.error ? { keychainError: diag.error } : {}),
    };
    // A miss (`absent`/`read-error`) is the diagnostic signal — the next git
    // operation has no credential and sync drops to an auth error. The hit
    // path stays at `debug` so healthy sync doesn't flood the log.
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

/**
 * Build the `auth git-credential` sub-command.
 * Registered under the `auth` command group.
 *
 * `getTokenStore` accepts `TokenStoreDiagnostics` so the `get` action can
 * observe the keychain read; `getLog` returns the CLI file logger (undefined
 * for invocations with no logger wired). The action flushes the async file
 * sink before `process.exit()` — without it, a record logged immediately
 * before exit is lost in the sonic-boom buffer, which is the exact case we
 * need persisted.
 */
export function gitCredentialCommand(
  getTokenStore: (diag?: TokenStoreDiagnostics) => Promise<TokenStore>,
  getLog?: () => PinoLoggerInstance | undefined,
): Command {
  const cmd = new Command('git-credential');
  cmd.description('Git credential helper (git credential-helper protocol)');

  cmd
    .command('get')
    .description('Lookup credentials from TokenStore (called by git)')
    .action(async () => {
      const log = getLog?.();
      try {
        let lastKeychainRead: KeychainReadInfo | undefined;
        const store = await getTokenStore({
          onKeychainRead: (info) => {
            lastKeychainRead = info;
          },
          onBackendSelected: (info) => {
            if (info.backend === 'file' && info.reason) {
              log?.warn({ backend: 'file', reason: info.reason }, '[auth] token storage fallback');
            }
          },
        });
        const exitCode = await handleCredentialGet(process.stdin, process.stdout, store, {
          log,
          getDiag: () => lastKeychainRead,
        });
        await flushFileLogger(log);
        process.exit(exitCode);
      } catch (err) {
        // A throw from getTokenStore / a callback / handleCredentialGet must
        // not skip the flush — that's the exact failure (a vanished credential)
        // we need persisted. Log and flush before exiting non-zero.
        log?.error(
          { error: err instanceof Error ? err.message : String(err) },
          '[auth] git-credential get: unexpected error',
        );
        await flushFileLogger(log);
        process.exit(1);
      }
    });

  return cmd;
}
