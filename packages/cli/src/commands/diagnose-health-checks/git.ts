import {
  assertGitAvailable,
  compareSemver,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
  MIN_GIT_VERSION,
  SYMLINK_MERGE_MIN_GIT_LABEL,
  SYMLINK_MERGE_MIN_GIT_VERSION,
} from '@inkeep/open-knowledge-server';
import type { CheckDefinition, CheckResult } from './types.ts';

interface GitCheckDeps {
  assert?: () => GitDetected;
}

export function makeGitCheck(deps: GitCheckDeps = {}): CheckDefinition {
  const assertFn = deps.assert ?? assertGitAvailable;
  return {
    name: 'git',
    run: async (): Promise<CheckResult> => {
      try {
        const detected = assertFn();
        const summary = `git ${detected.version} (${detected.source} — ${detected.resolvedPath})`;
        if (compareSemver(detected.version, SYMLINK_MERGE_MIN_GIT_VERSION) < 0) {
          return {
            name: 'git',
            status: 'warn',
            summary: `${summary}; sync refuses merges that change symlinks on Git older than ${SYMLINK_MERGE_MIN_GIT_LABEL}`,
            remediation: `Update Git to ${SYMLINK_MERGE_MIN_GIT_LABEL} or newer`,
          };
        }
        return { name: 'git', status: 'pass', summary };
      } catch (err) {
        if (err instanceof GitNotAvailableError) {
          return {
            name: 'git',
            status: 'fail',
            summary: 'git not found',
            remediation: err.guidance.options
              .map((opt) => `${opt.label}: ${opt.command}`)
              .join(' / '),
            detail: err.message,
          };
        }
        if (err instanceof GitTooOldError) {
          return {
            name: 'git',
            status: 'fail',
            summary: `git ${err.detected} is older than required ${err.required}`,
            remediation: err.guidance.options
              .map((opt) => `${opt.label}: ${opt.command}`)
              .join(' / '),
            detail: err.message,
          };
        }
        throw err;
      }
    },
  };
}

export { MIN_GIT_VERSION };
