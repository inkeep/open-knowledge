/**
 * Resolve a pre-merge overlap pause by committing the local
 * edits that caused it. POSTs to `/api/sync/resolve-blocking`.
 *
 * The request names the ACTION only. The server acts on the engine's own
 * blocking set, so this call cannot aim at a file the user is not being shown —
 * the same reason the endpoint refuses a body-supplied path list.
 *
 * Rejects when the action did not land, including the 409 the server returns
 * when nothing is blocking any more (a stale panel, or a second click after the
 * first already cleared it). Callers surface that rather than swallowing it:
 * the panel is showing state the user is acting on, so a silent no-op reads as
 * a dead button.
 */
export async function resolveBlockingChanges(action: 'commit'): Promise<void> {
  const res = await fetch('/api/sync/resolve-blocking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    throw new Error(`sync resolve-blocking failed: ${res.status}`);
  }
}
