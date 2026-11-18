import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { DESKTOP_PRODUCTS } from '@inkeep/open-knowledge-core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  BUNDLE_WRAPPER,
  bundleEntryFor,
  bundleWrapperFor,
  createBundleHandoverRelay,
  processExitCode,
  relayedServerEnv,
} from './bundle-identity.ts';

type BundleProxySuppression = 'env' | 'flag' | 'platform' | 'self' | null;

export interface BundleProxyDecision {
  proxy: boolean;
  suppressedBy: BundleProxySuppression;
}

export type BundleProxyMode =
  | 'bundled'
  | 'fallback-absent'
  | 'fallback-exec-failed'
  | 'suppressed-env'
  | 'suppressed-flag'
  | 'suppressed-platform'
  | 'suppressed-self';

const SUPPRESSION_HINT = 'Suppress with --no-bundle-proxy or OK_BUNDLE_PROXY=0.';
const DEFAULT_STARTUP_FAILURE_WINDOW_MS = 1_000;

export function findBundledOkPath(
  platform: NodeJS.Platform,
  home: string,
  fs: { existsSync(p: string): boolean },
): string | null {
  if (platform !== 'darwin') return null;
  const products = [DESKTOP_PRODUCTS.stable, DESKTOP_PRODUCTS.beta] as const;
  const candidates = products.flatMap((product) =>
    [join(home, 'Applications'), '/Applications'].map((applicationsDir) =>
      join(applicationsDir, `${product.productName}.app`, BUNDLE_WRAPPER),
    ),
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function shouldProxyToBundle(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  platform: NodeJS.Platform,
): BundleProxyDecision {
  if (platform !== 'darwin') return { proxy: false, suppressedBy: 'platform' };
  const envValue = env.OK_BUNDLE_PROXY?.toLowerCase();
  if (envValue === '0' || envValue === 'false') return { proxy: false, suppressedBy: 'env' };
  if (argv.includes('--no-bundle-proxy')) return { proxy: false, suppressedBy: 'flag' };
  if (typeof argv[1] === 'string' && bundleWrapperFor(argv[1]) !== undefined) {
    return { proxy: false, suppressedBy: 'self' };
  }
  return { proxy: true, suppressedBy: null };
}

export function emitBundleProxyEvent(params: {
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  mode: BundleProxyMode;
  bundlePath: string | null;
  reason: string | null;
}): void {
  params.stderr.write(
    `${JSON.stringify({
      event: 'mcp-bundle-proxy',
      mode: params.mode,
      bundlePath: params.bundlePath,
      reason: params.reason,
      hint: SUPPRESSION_HINT,
    })}\n`,
  );
}

export function proxyToBundle(params: {
  bundlePath: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  startupFailureWindowMs?: number;
  spawnImpl?: typeof spawn;
  exitProcess?: (code: number) => never;
  now?: () => number;
  hostIn?: Readable;
  hostOut?: Writable;
  signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
  platform?: NodeJS.Platform;
  watchIntervalMs?: number;
  drainTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}): Promise<never> {
  emitBundleProxyEvent({
    stderr: params.stderr,
    mode: 'bundled',
    bundlePath: params.bundlePath,
    reason: null,
  });

  const spawnFn = params.spawnImpl ?? spawn;
  const exitProcess = params.exitProcess ?? ((code: number): never => process.exit(code));
  const now = params.now ?? (() => Date.now());
  const hostIn = params.hostIn ?? process.stdin;
  const hostOut = params.hostOut ?? process.stdout;
  const signals = params.signals ?? process;
  const startedAt = now();
  const startupFailureWindowMs = params.startupFailureWindowMs ?? DEFAULT_STARTUP_FAILURE_WINDOW_MS;
  const childArgv = params.argv.filter((arg) => arg !== '--no-bundle-proxy');

  return new Promise((_resolve, reject) => {
    const reader = new ReadBuffer();
    const unansweredInput: Buffer[] = [];
    let stopping = false;
    let finished = false;

    const exitAfterFlush = (code: number): void => {
      hostOut.write('', () => exitProcess(code));
    };

    const relay = createBundleHandoverRelay({
      toHost: (message) =>
        new Promise((resolve) => {
          unansweredInput.length = 0;
          hostOut.write(serializeMessage(message), () => resolve());
        }),
      spawnServer: (launch) =>
        spawnFn(params.bundlePath, childArgv, {
          env: relayedServerEnv(params.env, launch),
          stdio: ['pipe', 'pipe', 'inherit'],
          detached: true,
          windowsHide: true,
        }),
      watch: {
        anchorPath: bundleEntryFor(params.bundlePath),
        platform: params.platform ?? process.platform,
        ...(params.watchIntervalMs !== undefined ? { intervalMs: params.watchIntervalMs } : {}),
      },
      log: (line) => params.stderr.write(`${line}\n`),
      ...(params.drainTimeoutMs !== undefined ? { drainTimeoutMs: params.drainTimeoutMs } : {}),
      ...(params.retryDelaysMs !== undefined ? { retryDelaysMs: params.retryDelaysMs } : {}),
      onServerExit: (exit) => {
        if (finished) return;
        finish();
        const startupFailure =
          exit.firstServer &&
          !exit.answeredHost &&
          !stopping &&
          (exit.error !== undefined || exit.signal !== null || exit.code !== 0) &&
          now() - startedAt <= startupFailureWindowMs;
        if (startupFailure) {
          handBackHostInput();
          reject(
            exit.error ??
              new Error(
                exit.signal !== null
                  ? `bundle process exited during startup by signal ${exit.signal}`
                  : `bundle process exited during startup with code ${exit.code ?? 0}`,
              ),
          );
          return;
        }
        exitAfterFlush(processExitCode(exit));
      },
      onUnrecoverable: () => {
        if (finished) return;
        finish();
        relay.stop();
        exitAfterFlush(1);
      },
    });

    const onData = (chunk: Buffer): void => {
      unansweredInput.push(chunk);
      reader.append(chunk);
      while (true) {
        let message: JSONRPCMessage | null;
        try {
          message = reader.readMessage();
        } catch (err) {
          params.stderr.write(
            `[mcp] dropped an unreadable line from the MCP host: ${String(err)}\n`,
          );
          continue;
        }
        if (message === null) break;
        relay.fromHost(message);
      }
    };

    const onHostEnd = (): void => {
      stopping = true;
      if (relay.stop()) return;
      finish();
      exitAfterFlush(0);
    };

    const onHostError = (err: Error): void => {
      params.stderr.write(
        `[mcp] MCP host stream error (${err.message}) — host disconnected, shutting down\n`,
      );
      onHostEnd();
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      stopping = true;
      if (relay.stop(signal)) return;
      finish();
      exitAfterFlush(processExitCode({ code: null, signal }));
    };

    function handBackHostInput(): void {
      hostIn.pause();
      if (!hostIn.readableEnded && unansweredInput.length > 0) {
        hostIn.unshift(Buffer.concat(unansweredInput));
      }
      const resumeForNextReader = (event: string | symbol): void => {
        if (event !== 'data') return;
        hostIn.off('newListener', resumeForNextReader);
        hostIn.resume();
      };
      hostIn.on('newListener', resumeForNextReader);
    }

    function finish(): void {
      finished = true;
      hostIn.off('data', onData);
      hostIn.off('end', onHostEnd);
      hostIn.off('error', onHostError);
      hostOut.off('error', onHostError);
      signals.off('SIGTERM', onSignal);
      signals.off('SIGINT', onSignal);
    }

    hostIn.on('data', onData);
    hostIn.on('end', onHostEnd);
    hostIn.on('error', onHostError);
    hostOut.on('error', onHostError);
    signals.on('SIGTERM', onSignal);
    signals.on('SIGINT', onSignal);
    relay.launchFirst();
  });
}
