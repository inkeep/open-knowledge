import {
  type GitNotAvailableError,
  type GitProbeTimeoutError,
  GitTooOldError,
} from './git-preflight.ts';
import { withSpanSync } from './telemetry.ts';

export const GIT_PREFLIGHT_FAIL_SPAN_NAME = 'ok.preflight.git.fail';

export type GitPreflightError = GitNotAvailableError | GitProbeTimeoutError | GitTooOldError;

const FAILURE_REASON_BY_CODE = {
  GIT_NOT_AVAILABLE: 'not_available',
  GIT_PROBE_TIMEOUT: 'probe_timeout',
  GIT_TOO_OLD: 'too_old',
} as const satisfies Record<GitPreflightError['code'], string>;

type GitPreflightFailureReason = (typeof FAILURE_REASON_BY_CODE)[GitPreflightError['code']];

const FAILURE_LOG_MESSAGE_BY_REASON = {
  not_available: 'git binary not found',
  probe_timeout: 'git probe timed out',
  too_old: 'git binary too old',
} as const satisfies Record<GitPreflightFailureReason, string>;

export interface GitPreflightFailure {
  readonly reason: GitPreflightFailureReason;
  readonly detectedVersion: string;
  readonly logMessage: (typeof FAILURE_LOG_MESSAGE_BY_REASON)[GitPreflightFailureReason];
}

export function describeGitPreflightFailure(err: GitPreflightError): GitPreflightFailure {
  const reason = FAILURE_REASON_BY_CODE[err.code];
  return {
    reason,
    detectedVersion: err instanceof GitTooOldError ? err.detected : '',
    logMessage: FAILURE_LOG_MESSAGE_BY_REASON[reason],
  };
}

export function emitPreflightFailureSpan(err: GitPreflightError): void {
  const { reason, detectedVersion } = describeGitPreflightFailure(err);
  withSpanSync(
    GIT_PREFLIGHT_FAIL_SPAN_NAME,
    {
      attributes: {
        'ok.platform': err.platform,
        'ok.preflight.git.reason': reason,
        'ok.preflight.git.detected_version': detectedVersion,
      },
    },
    () => {},
  );
}
