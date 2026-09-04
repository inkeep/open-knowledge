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
