import { okUserHomeDisplayPath } from '@inkeep/open-knowledge-core';
import {
  type ProcessStart,
  readProcessStart,
  registerNativeProcessStartReader,
} from '@inkeep/open-knowledge-server';
import { getCliLogger } from '../cli-logger.ts';
import {
  debugNativeLoadFailure,
  describeNativeFailure,
  describeValue,
  type NativeConfigResolver,
  requireNativeConfigModule,
} from '../native/load-native-config.ts';

const MAX_PROCESS_ID = 0xffff_ffff;

type NativeFailureKind = 'unavailable' | 'query-failed';

export interface NativeFailure {
  kind: NativeFailureKind;
  reason: string;
}

export interface WindowsNativeProcessStartOptions {
  arch?: NodeJS.Architecture;
  nativeResolver?: Partial<NativeConfigResolver>;
  onNativeFailure?: (failure: NativeFailure) => void;
}

export interface HolderProcessStartOptions {
  platform?: NodeJS.Platform;
  onNativeFailure?: (failure: NativeFailure) => void;
}

type NativeFailureLogRecord = {
  event: 'process-start-native-failure';
  lockPid: number;
  kind: NativeFailureKind;
  reasons: string[];
};

interface NativeFailureLog {
  warn(data: NativeFailureLogRecord, message: string): void;
}

function describeBinding(binding: unknown): string {
  if (!binding || typeof binding !== 'object') return String(binding);
  const exported = typeof (binding as Record<string, unknown>).readProcessStart;
  return `${describeValue(binding)} readProcessStart=${exported}`;
}

export function readWindowsNativeProcessStart(
  pid: number,
  options: WindowsNativeProcessStartOptions = {},
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_ID) return null;
  const arch = options.arch ?? process.arch;
  const reportNativeFailure = (kind: NativeFailureKind, context: string, detail: unknown): void => {
    debugNativeLoadFailure(context, detail);
    options.onNativeFailure?.({ kind, reason: describeNativeFailure(context, detail) });
  };
  try {
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
  } catch (err) {
    reportNativeFailure('query-failed', 'readProcessStart failed', err);
    return null;
  }
}

export function readHolderProcessStart(
  pid: number,
  options: HolderProcessStartOptions = {},
): ProcessStart | null {
  return readProcessStart(pid, {
    platform: options.platform,
    readNative: (nativePid) =>
      readWindowsNativeProcessStart(nativePid, { onNativeFailure: options.onNativeFailure }),
  });
}

export function describeHolderStartReadFailure(args: {
  platform: NodeJS.Platform;
  pid: number;
  nativeFailures: readonly NativeFailure[];
  causeRecorded: boolean;
}): string {
  const { platform, pid, nativeFailures, causeRecorded } = args;
  const componentUnavailable = nativeFailures.some((failure) => {
    switch (failure.kind) {
      case 'unavailable':
        return true;
      case 'query-failed':
        return false;
      default: {
        const exhaustive: never = failure.kind;
        return exhaustive;
      }
    }
  });
  const windowsRecovery =
    nativeFailures.length === 0
      ? ''
      : componentUnavailable
        ? 'Reinstall OpenKnowledge to restore the Windows component that verifies process identity. '
        : 'The Windows component loaded but the operating system refused the query, so reinstalling will not help; retry from an account that can inspect that process. ';
  const probeRecovery =
    platform === 'linux'
      ? `Linux reads the process start from /proc/${pid}/stat and /proc/stat; restore read access to /proc and retry. `
      : platform === 'darwin'
        ? 'macOS reads the process start with ps, and that read failed, as it does inside some sandboxes; retry from a shell where ps can run. '
        : platform === 'win32'
          ? windowsRecovery
          : '';
  const causeRecord =
    nativeFailures.length > 0 && causeRecorded
      ? `The failure detail is recorded in the CLI log under ${okUserHomeDisplayPath('logs')}. `
      : '';
  return probeRecovery + causeRecord;
}

export function registerWindowsProcessStartReader(log?: NativeFailureLog): () => void {
  const recordedKinds = new Set<NativeFailureKind>();
  return registerNativeProcessStartReader((pid) => {
    const failures: NativeFailure[] = [];
    const startedAt = readWindowsNativeProcessStart(pid, {
      onNativeFailure: (failure) => {
        failures.push(failure);
      },
    });
    for (const kind of new Set(failures.map((failure) => failure.kind))) {
      if (recordedKinds.has(kind)) continue;
      recordedKinds.add(kind);
      (log ?? getCliLogger())?.warn(
        {
          event: 'process-start-native-failure',
          lockPid: pid,
          kind,
          reasons: failures.filter((failure) => failure.kind === kind).map((f) => f.reason),
        },
        'the Windows process-start query failed, so lock holders cannot be verified; later failures of this kind are not recorded again',
      );
    }
    return startedAt;
  });
}
