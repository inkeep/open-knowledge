/**
 * 5-class error taxonomy for git sync operations.
 *
 * Inspired by Temporal's ApplicationFailure.non_retryable pattern:
 * each class is explicitly tagged as retryable or non-retryable so
 * callers can decide recovery strategy without inspecting raw stderr.
 */

import {
  classifyGitAuthError,
  type GitAuthFailureSubclass,
  type SyncErrorCode,
} from '@inkeep/open-knowledge-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subclass strings, narrowed per class. */
type NetworkSubclass = 'dns' | 'timeout' | '5xx' | '429' | 'connection-refused' | 'unknown-network';
type AuthSubclass =
  | '401'
  | '403'
  | 'expired-token'
  | 'scope-mismatch'
  | 'no-credential'
  | 'ssh-auth'
  | 'unknown-auth';
type SemanticSubclass =
  | 'non-fast-forward'
  | 'protected-branch'
  | 'merge-conflict'
  | 'unknown-semantic';
type StructuralSubclass =
  | 'lfs-quota'
  | 'large-file'
  | 'pre-receive-hook'
  | 'secret-detected'
  | 'unknown-structural';
type LocalSubclass = 'index-lock' | 'dirty-tree' | 'disk-full' | 'unknown-local';

/**
 * Bounded enum of UI-localizable error codes the sync UI maps to translated
 * strings via Lingui. The wire never carries an English sentence — only the
 * code travels server-to-client; the UI looks up the user-visible copy.
 *
 * Codes mirror the `<class>/<subclass>` taxonomy. The literals are single-
 * sourced as `SYNC_ERROR_CODES` in `@inkeep/open-knowledge-core` (the wire
 * schema lives there too); this is the server-facing alias. Add a new code by
 * extending that tuple, then map the new `(class, subclass)` case in
 * `deriveUserFacingCode` below. The mapping is not compiler-enforced — the
 * if-chain falls through to `null`, so a missing case fails open at runtime
 * (raw message instead of localized copy) rather than failing to typecheck.
 */
export type UserFacingErrorCode = SyncErrorCode;

/** Tagged result from classifyGitError(). */
export type ClassifiedError =
  | {
      class: 'network';
      subclass: NetworkSubclass;
      retryable: true;
      message: string;
      userFacingCode: UserFacingErrorCode | null;
      rawStderr?: string;
    }
  | {
      class: 'auth';
      subclass: AuthSubclass;
      retryable: false;
      message: string;
      userFacingCode: UserFacingErrorCode | null;
      rawStderr?: string;
    }
  | {
      class: 'semantic';
      subclass: SemanticSubclass;
      retryable: false;
      message: string;
      userFacingCode: UserFacingErrorCode | null;
      rawStderr?: string;
    }
  | {
      class: 'structural';
      subclass: StructuralSubclass;
      retryable: false;
      message: string;
      userFacingCode: UserFacingErrorCode | null;
      rawStderr?: string;
    }
  | {
      class: 'local';
      subclass: LocalSubclass;
      retryable: true;
      message: string;
      userFacingCode: UserFacingErrorCode | null;
      rawStderr?: string;
    };

/**
 * Map a `(class, subclass)` tuple to a `UserFacingErrorCode` for the sync
 * UI to localize. Returns `null` for variants with no override; callers
 * fall back to the developer-facing `message` field on render.
 */
export function deriveUserFacingCode(
  cls: ClassifiedError['class'],
  subclass: string,
): UserFacingErrorCode | null {
  if (cls === 'auth' && subclass === '403') return 'auth-403';
  if (cls === 'auth' && subclass === '401') return 'auth-401';
  if (cls === 'auth' && subclass === 'scope-mismatch') return 'auth-scope-mismatch';
  if (cls === 'auth' && subclass === 'no-credential') return 'auth-no-credential';
  if (cls === 'semantic' && subclass === 'protected-branch') return 'semantic-protected-branch';
  return null;
}

// ---------------------------------------------------------------------------
// Stderr pattern matchers
// ---------------------------------------------------------------------------

function extractStderr(error: Error): string {
  // simple-git errors may have a `git` property or message with stderr
  const raw = (error as unknown as Record<string, unknown>).git?.toString() ?? error.message ?? '';
  return raw;
}

function matchesAny(haystack: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(haystack));
}

// ---------------------------------------------------------------------------
// Class 2 (Auth) — regex banks live in @inkeep/open-knowledge-core
// (`classifyGitAuthError`); this module delegates to keep one source of
// truth for the auth patterns the CLI's `ok clone` catch and the server
// share.
// ---------------------------------------------------------------------------

const AUTH_SUBCLASS_MESSAGES: Record<GitAuthFailureSubclass, string> = {
  'no-credential': 'No GitHub credential available — reconnect to resume syncing',
  '401': 'Authentication failed — token may be expired',
  '403': 'Access denied (403)',
  'scope-mismatch': 'GitHub token missing required scopes',
  'ssh-auth': 'SSH authentication failed — check your SSH key or host-key trust',
  'unknown-auth': 'Authentication failed',
};

// ---------------------------------------------------------------------------
// Class 3 (Semantic) matchers
// ---------------------------------------------------------------------------

const NON_FAST_FORWARD_PATTERNS: RegExp[] = [
  /non-fast-forward/i,
  /rejected.*non-fast-forward/i,
  /would overwrite.*commits/i,
  /\[rejected\]/,
  /fetch first/i,
  /updates were rejected/i,
];

const PROTECTED_BRANCH_PATTERNS: RegExp[] = [
  /protected branch/i,
  /refusing to allow/i,
  /at least \d+ approving review/i,
  /required status check/i,
  /branch policy/i,
  // GitHub-specific error codes (GH001-GH004 dugite equivalents)
  /GH001/i,
  /GH002/i,
  /GH003/i,
  /GH004/i,
  // GitHub API rejection wording
  /push declined due to repository rule/i,
  /cannot push to a protected branch/i,
];

const MERGE_CONFLICT_PATTERNS: RegExp[] = [
  /\bmerge conflict\b/i,
  /automatic merge failed/i,
  /CONFLICT \(/,
  /\bconflict\b.*\bmerge\b/i,
  // simple-git's GitResponseError wraps MergeSummaryDetail; both its
  // `message` and `error.git.toString()` produce "CONFLICTS: file:reason[, …]".
  /(?:^|\n)CONFLICTS:\s/i,
];

// ---------------------------------------------------------------------------
// Class 4 (Structural) matchers
// ---------------------------------------------------------------------------

const LFS_PATTERNS: RegExp[] = [/lfs.*quota/i, /exceeded.*bandwidth/i, /lfs storage/i];

const LARGE_FILE_PATTERNS: RegExp[] = [
  /file.*too large/i,
  /exceeded.*file size/i,
  /push file size limit/i,
];

const PRE_RECEIVE_PATTERNS: RegExp[] = [
  /pre-receive hook/i,
  /remote:.*rejected/i,
  /hook declined/i,
];

const SECRET_DETECTED_PATTERNS: RegExp[] = [
  /secret.*detected/i,
  /push.*secret/i,
  /secret scanning/i,
  /leaking.*credentials/i,
  /token.*detected/i,
];

// ---------------------------------------------------------------------------
// Class 5 (Local) matchers
// ---------------------------------------------------------------------------

const INDEX_LOCK_PATTERNS: RegExp[] = [
  /\.git\/index\.lock/i,
  /another git process/i,
  /unable to create.*\.lock/i,
];

const DIRTY_TREE_PATTERNS: RegExp[] = [
  /dirty.*working tree/i,
  /working tree.*not clean/i,
  /untracked.*files.*would be overwritten/i,
  /local changes.*would be overwritten/i,
  /uncommitted changes/i,
  /changes.*not staged/i,
  /please.*commit.*changes/i,
  /please.*stash/i,
  /commit your changes or stash/i,
];

const DISK_FULL_PATTERNS: RegExp[] = [
  /no space left on device/i,
  /disk quota exceeded/i,
  /ENOSPC/i,
];

// ---------------------------------------------------------------------------
// Class 1 (Network) matchers
// ---------------------------------------------------------------------------

const NETWORK_PATTERNS: RegExp[] = [
  /could not resolve host/i,
  /name.*resolution/i,
  /connection.*timed out/i,
  /operation timed out/i,
  /connection refused/i,
  /network.*unreachable/i,
  /ssl.*handshake/i,
  /unable to connect/i,
  /getaddrinfo/i,
  /econnrefused/i,
  /enotfound/i,
  /etimedout/i,
  /ehostunreach/i,
];

// Anchored to HTTP-status contexts so unrelated 3-digit numbers (file paths
// like `/data/file501.txt`, error text like "502 bytes") don't route local
// faults into the network class with retry/backoff.
const HTTP_5XX_PATTERNS: RegExp[] = [
  /\bHTTP[\s/]*5[0-9]{2}\b/i,
  /\bstatus:?\s*5[0-9]{2}\b/i,
  /\berror\s*5[0-9]{2}\b/i,
  /\bresponse.*?\b5[0-9]{2}\b/i,
];
const HTTP_429_PATTERNS: RegExp[] = [
  /\bHTTP[\s/]*429\b/i,
  /\bstatus:?\s*429\b/i,
  /\berror\s*429\b/i,
  /rate.?limit/i,
  /too many requests/i,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Variant of {@link ClassifiedError} omitting `userFacingCode` — the shape
 * `classifyGitErrorBase` returns before the public wrapper attaches the UI
 * code. Keeping the helper at this shape lets each return site stay focused
 * on the developer-facing message; the user-facing code is derived once.
 */
type ClassifiedErrorBase = Omit<ClassifiedError, 'userFacingCode'>;

/**
 * Classify a git operation error into one of 5 retry-tagged classes.
 *
 * Priority order (most specific first):
 *   1. Local (index.lock, dirty tree) — must check before semantic
 *   2. Auth (401, 403, bad credentials)
 *   3. Semantic (protected branch > non-FF > merge conflict)
 *   4. Structural (LFS, large file, pre-receive, secret)
 *   5. Network (DNS, timeout, 5xx, 429)
 *   6. Local fallback (catch-all for git process errors)
 *
 * Public wrapper: classifies then attaches a `userFacingCode` for the sync
 * UI to map to a localized string via Lingui (or `null` to fall through to
 * the developer-facing `message`).
 */
export function classifyGitError(error: Error | unknown): ClassifiedError {
  const base = classifyGitErrorBase(error);
  return {
    ...base,
    userFacingCode: deriveUserFacingCode(base.class, base.subclass),
  } as ClassifiedError;
}

function classifyGitErrorBase(error: Error | unknown): ClassifiedErrorBase {
  const err = error instanceof Error ? error : new Error(String(error));
  const raw = extractStderr(err);
  const combined = `${err.message}\n${raw}`.toLowerCase();

  // --- Class 5 (Local) — check early to avoid misclassifying index.lock as auth
  if (matchesAny(combined, INDEX_LOCK_PATTERNS)) {
    return {
      class: 'local',
      subclass: 'index-lock',
      retryable: true,
      message: 'Git index locked by another process',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, DIRTY_TREE_PATTERNS)) {
    return {
      class: 'local',
      subclass: 'dirty-tree',
      retryable: true,
      message: 'Working tree has uncommitted changes',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, DISK_FULL_PATTERNS)) {
    return {
      class: 'local',
      subclass: 'disk-full',
      retryable: true,
      message: 'Disk full or quota exceeded',
      rawStderr: raw,
    };
  }

  // --- Class 2 (Auth) — delegated to @inkeep/open-knowledge-core. A 403
  // that matches a protected-branch pattern is reclassified to semantic
  // here so push-rejected-by-branch-policy doesn't get rendered as a
  // generic access denial.
  const authResult = classifyGitAuthError(err);
  if (authResult.kind === 'auth') {
    if (authResult.subclass === '403' && matchesAny(combined, PROTECTED_BRANCH_PATTERNS)) {
      return {
        class: 'semantic',
        subclass: 'protected-branch',
        retryable: false,
        message: 'Push rejected — branch is protected',
        rawStderr: raw,
      };
    }
    return {
      class: 'auth',
      subclass: authResult.subclass,
      retryable: false,
      message: AUTH_SUBCLASS_MESSAGES[authResult.subclass],
      rawStderr: raw,
    };
  }

  // --- Class 3 (Semantic)
  if (matchesAny(combined, PROTECTED_BRANCH_PATTERNS)) {
    return {
      class: 'semantic',
      subclass: 'protected-branch',
      retryable: false,
      message: 'Push rejected — branch is protected',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, NON_FAST_FORWARD_PATTERNS)) {
    return {
      class: 'semantic',
      subclass: 'non-fast-forward',
      retryable: false,
      message: 'Push rejected — remote has diverged (non-fast-forward)',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, MERGE_CONFLICT_PATTERNS)) {
    return {
      class: 'semantic',
      subclass: 'merge-conflict',
      retryable: false,
      message: 'Merge conflict — manual resolution required',
      rawStderr: raw,
    };
  }

  // --- Class 4 (Structural)
  if (matchesAny(combined, LFS_PATTERNS)) {
    return {
      class: 'structural',
      subclass: 'lfs-quota',
      retryable: false,
      message: 'Git LFS quota exceeded',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, LARGE_FILE_PATTERNS)) {
    return {
      class: 'structural',
      subclass: 'large-file',
      retryable: false,
      message: 'File exceeds size limit',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, SECRET_DETECTED_PATTERNS)) {
    return {
      class: 'structural',
      subclass: 'secret-detected',
      retryable: false,
      message: 'Push blocked — secret or credential detected in content',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, PRE_RECEIVE_PATTERNS)) {
    return {
      class: 'structural',
      subclass: 'pre-receive-hook',
      retryable: false,
      message: 'Push rejected by server pre-receive hook',
      rawStderr: raw,
    };
  }

  // --- Class 1 (Network)
  if (matchesAny(combined, HTTP_429_PATTERNS)) {
    return {
      class: 'network',
      subclass: '429',
      retryable: true,
      message: 'Rate limited — too many requests',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, HTTP_5XX_PATTERNS)) {
    return {
      class: 'network',
      subclass: '5xx',
      retryable: true,
      message: 'Server error (5xx)',
      rawStderr: raw,
    };
  }
  if (matchesAny(combined, NETWORK_PATTERNS)) {
    if (/timed? out/i.test(combined)) {
      return {
        class: 'network',
        subclass: 'timeout',
        retryable: true,
        message: 'Connection timed out',
        rawStderr: raw,
      };
    }
    if (/refused/i.test(combined) || /econnrefused/i.test(combined)) {
      return {
        class: 'network',
        subclass: 'connection-refused',
        retryable: true,
        message: 'Connection refused',
        rawStderr: raw,
      };
    }
    if (
      /resolve.*host/i.test(combined) ||
      /enotfound/i.test(combined) ||
      /getaddrinfo/i.test(combined)
    ) {
      return {
        class: 'network',
        subclass: 'dns',
        retryable: true,
        message: 'DNS resolution failed',
        rawStderr: raw,
      };
    }
    return {
      class: 'network',
      subclass: 'unknown-network',
      retryable: true,
      message: 'Network error',
      rawStderr: raw,
    };
  }

  // --- Class 5 fallback (local unknown)
  return {
    class: 'local',
    subclass: 'unknown-local',
    retryable: true,
    message: err.message || 'Unknown git error',
    rawStderr: raw,
  };
}
