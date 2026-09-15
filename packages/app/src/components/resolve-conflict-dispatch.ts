import { ProblemDetailsSchema, type ProblemType } from '@inkeep/open-knowledge-core';

type ResolveStrategy = 'mine' | 'theirs' | 'content' | 'delete';

const NO_CONFLICT_TRACKED = 'urn:ok:error:no-conflict-tracked' satisfies ProblemType;

export type ResolveConflictResult =
  | { ok: true }
  | { ok: false; reason: 'no-conflict-tracked' | 'failed'; detail?: string };

async function dispatchResolve(
  file: string,
  strategy: ResolveStrategy,
  content?: string,
): Promise<ResolveConflictResult> {
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
    const payload: unknown = await res.json().catch(() => null);
    const problem = ProblemDetailsSchema.safeParse(payload);
    let detail: string | undefined;
    if (typeof payload === 'object' && payload !== null) {
      if ('detail' in payload && typeof payload.detail === 'string') detail = payload.detail;
      else if ('title' in payload && typeof payload.title === 'string') detail = payload.title;
    }
    if (problem.success && res.status === 404 && problem.data.type === NO_CONFLICT_TRACKED) {
      return { ok: false, reason: 'no-conflict-tracked', detail };
    }
    return { ok: false, reason: 'failed', detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: 'resolve-conflict-dispatch-failed',
        file,
        strategy,
        detail,
      }),
    );
    return { ok: false, reason: 'failed', detail };
  }
}

export async function resolveConflictContent(
  file: string,
  content: string,
): Promise<ResolveConflictResult> {
  return dispatchResolve(file, 'content', content);
}

export async function resolveConflictMine(file: string): Promise<ResolveConflictResult> {
  return dispatchResolve(file, 'mine');
}

export async function resolveConflictTheirs(file: string): Promise<ResolveConflictResult> {
  return dispatchResolve(file, 'theirs');
}

export async function resolveConflictDelete(file: string): Promise<ResolveConflictResult> {
  return dispatchResolve(file, 'delete');
}
