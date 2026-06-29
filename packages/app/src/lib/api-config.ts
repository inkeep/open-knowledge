interface ApiConfig {
  collabUrl: string | null;
  previewUrl: string | null;
  port: number;
  paneTarget: string | null;
  singleFile: boolean;
}

export type FetchApiConfigResult =
  | { status: 'ok'; config: ApiConfig }
  | { status: 'absent' }
  | { status: 'error'; code: number | 'network' | 'invalid-body' };

export async function fetchApiConfig(signal?: AbortSignal): Promise<FetchApiConfigResult> {
  let res: Response;
  try {
    res = await fetch('/api/config', {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    return { status: 'error', code: 'network' };
  }
  if (res.status === 404 || res.status === 501) {
    return { status: 'absent' };
  }
  if (!res.ok) {
    return { status: 'error', code: res.status };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', code: 'invalid-body' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'error', code: 'invalid-body' };
  }
  const obj = body as Record<string, unknown>;
  return {
    status: 'ok',
    config: {
      collabUrl: typeof obj.collabUrl === 'string' ? obj.collabUrl : null,
      previewUrl: typeof obj.previewUrl === 'string' ? obj.previewUrl : null,
      port: typeof obj.port === 'number' ? obj.port : 0,
      paneTarget: typeof obj.paneTarget === 'string' ? obj.paneTarget : null,
      singleFile: obj.singleFile === true,
    },
  };
}
