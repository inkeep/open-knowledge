import { spawn } from 'node:child_process';
import { join } from 'node:path';

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

const BUNDLE_RELATIVE_OK = join('Contents', 'Resources', 'cli', 'bin', 'ok.sh');
const BUNDLE_CLI_RE = /Contents\/Resources\/cli\/dist\/cli\.mjs$/;
const SUPPRESSION_HINT = 'Suppress with --no-bundle-proxy or OK_BUNDLE_PROXY=0.';
const DEFAULT_STARTUP_FAILURE_WINDOW_MS = 1_000;

export function findBundledOkPath(
  platform: NodeJS.Platform,
  home: string,
  fs: { existsSync(p: string): boolean },
): string | null {
  if (platform !== 'darwin') return null;
  const candidates = [
    join(home, 'Applications', 'OpenKnowledge.app', BUNDLE_RELATIVE_OK),
    join('/Applications', 'OpenKnowledge.app', BUNDLE_RELATIVE_OK),
  ];
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
  if (typeof argv[1] === 'string' && BUNDLE_CLI_RE.test(argv[1])) {
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
  stderr: NodeJS.WriteStream;
  startupFailureWindowMs?: number;
  spawnImpl?: typeof spawn;
  exitProcess?: (code: number) => never;
  now?: () => number;
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
  const startedAt = now();
  const startupFailureWindowMs = params.startupFailureWindowMs ?? DEFAULT_STARTUP_FAILURE_WINDOW_MS;

  return new Promise((_resolve, reject) => {
    const child = spawnFn(
      params.bundlePath,
      params.argv.filter((arg) => arg !== '--no-bundle-proxy'),
      {
        env: { ...params.env, OK_BUNDLE_PROXY: '0' },
        stdio: 'inherit',
        windowsHide: true,
      },
    );

    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const cleanup = () => {
      process.off('SIGTERM', forwardSignal);
      process.off('SIGINT', forwardSignal);
    };

    process.on('SIGTERM', forwardSignal);
    process.on('SIGINT', forwardSignal);

    child.once('error', (err) => {
      cleanup();
      reject(err);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (signal) {
        reject(new Error(`bundle process exited by signal ${signal}`));
        return;
      }
      const exitCode = code ?? 0;
      const elapsedMs = now() - startedAt;
      if (exitCode !== 0 && elapsedMs <= startupFailureWindowMs) {
        reject(new Error(`bundle process exited during startup with code ${exitCode}`));
        return;
      }
      exitProcess(exitCode);
    });
  });
}
