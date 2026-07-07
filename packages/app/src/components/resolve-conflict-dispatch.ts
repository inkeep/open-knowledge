/**
 * Client-side dispatcher for `POST /api/sync/resolve-conflict`.
 *
 * The DiffView's "Save resolution" path receives the per-hunk merged
 * content via its `onResolve(content)` callback; DiffViewBoundary wires
 * that callback through `resolveConflictContent` below. Returns
 * `{ok, detail}` so the caller can surface the server's RFC 9457
 * `detail` field (git stderr text) in its own toast.
 */

/** Mirrors the server-side enum at `packages/server/src/conflict-storage.ts`. */
type ResolveStrategy = 'mine' | 'theirs' | 'content' | 'delete';

interface DispatchResult {
  ok: boolean;
  /** RFC 9457 `detail` field surfaced to the toast when the server provides one. */
  detail?: string;
}

async function dispatchResolve(
  file: string,
  strategy: ResolveStrategy,
  content?: string,
): Promise<DispatchResult> {
  try {
    const body: { file: string; strategy: ResolveStrategy; content?: string } = {
      file,
      strategy,
    };
    if (content !== undefined) body.content = content;
    const res = await fetch('/api/sync/resolve-conflict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    // RFC 9457 problem+json bodies carry the git stderr in `detail` so
    // operators can distinguish a transient network glitch from a hook-
    // rejected commit. Tolerate non-JSON responses (network outage, 5xx
    // before the envelope wraps) by falling back to undefined.
    let detail: string | undefined;
    try {
      const payload = (await res.json()) as { detail?: unknown; title?: unknown };
      if (typeof payload.detail === 'string') detail = payload.detail;
      else if (typeof payload.title === 'string') detail = payload.title;
    } catch {
      // ignore body parse error — surface the bare failure
    }
    return { ok: false, detail };
  } catch (err) {
    // Structured warn — pairs with the server-side
    // `respondDocInConflict` event so operators correlating UI toast
    // failures with server logs always have a network-layer signal.
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: 'conflict-resolve-dispatch-failed',
        file,
        strategy,
        detail,
      }),
    );
    return { ok: false, detail };
  }
}

export async function resolveConflictContent(
  file: string,
  content: string,
): Promise<DispatchResult> {
  return dispatchResolve(file, 'content', content);
}

/** Resolve by keeping the local (`:2:`) stage. Fails on delete-modify (DU). */
export async function resolveConflictMine(file: string): Promise<DispatchResult> {
  return dispatchResolve(file, 'mine');
}

/** Resolve by accepting the remote (`:3:`) stage. Fails on modify-delete (UD). */
export async function resolveConflictTheirs(file: string): Promise<DispatchResult> {
  return dispatchResolve(file, 'theirs');
}

/**
 * Resolve by deleting the file (`git rm`). Honors deletion intent for
 * delete-modify (DU — "keep my deletion") and modify-delete (UD — "accept
 * their deletion") shapes.
 */
export async function resolveConflictDelete(file: string): Promise<DispatchResult> {
  return dispatchResolve(file, 'delete');
}
