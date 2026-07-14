/**
 * Commit-gated cleanup for one desktop-owned remote-project transport.
 *
 * WindowManager may call a fresh session's cleanup before its window is
 * committed (load failure or one-window-per-project dedup). In that case only
 * the fresh transport belongs to the caller; attached terminal windows and the
 * current fingerprint still belong to the already-open editor. Once committed,
 * the authoritative owner revokes attached terminals before closing the SSH
 * transport and finally releases the fingerprint authority.
 */

export interface RemoteSessionCleanup {
  commit(): void;
  close(): void;
}

export function createRemoteSessionCleanup(deps: {
  closeAttachedWindows(): void;
  closeTransport(): void;
  isAuthoritative(): boolean;
  releaseAuthority(): void;
}): RemoteSessionCleanup {
  let committed = false;
  let closed = false;

  return {
    commit(): void {
      if (!closed) committed = true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      const releaseProject = committed && deps.isAuthoritative();
      try {
        if (releaseProject) deps.closeAttachedWindows();
      } finally {
        try {
          deps.closeTransport();
        } finally {
          if (releaseProject) deps.releaseAuthority();
        }
      }
    },
  };
}
