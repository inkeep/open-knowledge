type ResolveStrategy = 'mine' | 'theirs' | 'content' | 'delete';

interface DispatchResult {
  ok: boolean;
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
    let detail: string | undefined;
    try {
      const payload = (await res.json()) as { detail?: unknown; title?: unknown };
      if (typeof payload.detail === 'string') detail = payload.detail;
      else if (typeof payload.title === 'string') detail = payload.title;
    } catch {}
    return { ok: false, detail };
  } catch (err) {
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

export async function resolveConflictMine(file: string): Promise<DispatchResult> {
  return dispatchResolve(file, 'mine');
}

export async function resolveConflictTheirs(file: string): Promise<DispatchResult> {
  return dispatchResolve(file, 'theirs');
}

export async function resolveConflictDelete(file: string): Promise<DispatchResult> {
  return dispatchResolve(file, 'delete');
}
