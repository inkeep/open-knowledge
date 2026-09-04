export async function triggerSync(op: 'sync' | 'push' | 'pull' | 'fetch'): Promise<void> {
  const res = await fetch('/api/sync/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  });
  if (!res.ok) {
    throw new Error(`sync trigger failed: ${res.status}`);
  }
}
