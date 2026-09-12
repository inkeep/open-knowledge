import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import {
  debugNativeLoadFailure,
  describeNativeFailure,
  describeValue,
  type NativeConfigResolver,
  requireNativeConfigModule,
} from '../native/load-native-config.ts';

const PS_PROCESS_START_QUERY_TIMEOUT_MS = 5000;
const MAX_PROCESS_ID = 0xffff_ffff;

type NativeFailureKind = 'unavailable' | 'query-failed';

export interface NativeFailure {
  kind: NativeFailureKind;
  reason: string;
}

export interface ProcessStartOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  nativeResolver?: Partial<NativeConfigResolver>;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
  onNativeFailure?: (failure: NativeFailure) => void;
}

function describeBinding(binding: unknown): string {
  if (!binding || typeof binding !== 'object') return String(binding);
  const exported = typeof (binding as Record<string, unknown>).readProcessStart;
  return `${describeValue(binding)} readProcessStart=${exported}`;
}

export function readRemovalProcessStart(
  pid: number,
  options: ProcessStartOptions = {},
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_ID) return null;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const reportNativeFailure = (kind: NativeFailureKind, context: string, detail: unknown): void => {
    debugNativeLoadFailure(context, detail);
    options.onNativeFailure?.({ kind, reason: describeNativeFailure(context, detail) });
  };
  try {
    if (platform === 'win32') {
      let loadFailureReported = false;
      const binding = requireNativeConfigModule(options.nativeResolver, (context, detail) => {
        loadFailureReported = true;
        reportNativeFailure('unavailable', context, detail);
      });
      if (
        !binding ||
        typeof binding !== 'object' ||
        !('readProcessStart' in binding) ||
        typeof binding.readProcessStart !== 'function'
      ) {
        let detail: string;
        if (binding !== null && binding !== undefined) detail = describeBinding(binding);
        else if (loadFailureReported) detail = 'no usable binding was returned';
        else detail = 'the addon was not found';
        reportNativeFailure(
          'unavailable',
          `the Windows native addon (native-config.win32-${arch}-msvc.node) did not load or does not export readProcessStart`,
          detail,
        );
        return null;
      }
      const startedAt: unknown = binding.readProcessStart(pid);
      if (typeof startedAt === 'number' && Number.isSafeInteger(startedAt) && startedAt >= 0)
        return startedAt;
      reportNativeFailure(
        'unavailable',
        'readProcessStart returned an invalid value',
        describeValue(startedAt),
      );
      return null;
    } else if (platform === 'darwin' || platform === 'linux') {
      const env = options.env ?? process.env;
      const run = options.run ?? execFileSync;
      const commandOptions: ExecFileSyncOptionsWithStringEncoding = {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PS_PROCESS_START_QUERY_TIMEOUT_MS,
        windowsHide: true,
        env: { ...env, LC_ALL: 'C', TZ: 'UTC0' },
      };
      const raw = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], commandOptions).trim();
      if (!/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(raw)) return null;
      const startedAt = Date.parse(`${raw} UTC`);
      return Number.isFinite(startedAt) ? startedAt : null;
    } else {
      return null;
    }
  } catch (err) {
    if (platform === 'win32') reportNativeFailure('query-failed', 'readProcessStart failed', err);
    return null;
  }
}
