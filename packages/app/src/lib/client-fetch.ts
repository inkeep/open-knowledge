import { browserClientVersionHeaders } from '@/lib/client-version';

interface ClientFetchConfig {
  apiOrigin?: string;
}

const FETCH_WRAPPER_MARKER = Symbol.for('ok.client.fetchWrapper');

export function installClientFetchWrapper(config: ClientFetchConfig = {}): void {
  if (typeof window === 'undefined') return;
  const apiOrigin = config.apiOrigin && config.apiOrigin.length > 0 ? config.apiOrigin : undefined;

  const current = window.fetch as typeof window.fetch & { [FETCH_WRAPPER_MARKER]?: true };
  if (current[FETCH_WRAPPER_MARKER]) return;

  const origFetch = window.fetch.bind(window);
  const versionHeaders = browserClientVersionHeaders();

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = resolveApiTarget(input, apiOrigin);
    if (!target.isApi) return origFetch(input, init);

    if (input instanceof Request) {
      const headers = mergeHeaders(input.headers, versionHeaders);
      return origFetch(new Request(target.url, input), { headers });
    }
    const headers = mergeHeaders(init?.headers, versionHeaders);
    return origFetch(target.url, { ...init, headers });
  }) as typeof window.fetch & { [FETCH_WRAPPER_MARKER]?: true };

  wrapped[FETCH_WRAPPER_MARKER] = true;
  window.fetch = wrapped;
}

function mergeHeaders(existing: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(existing);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

interface ApiTarget {
  isApi: boolean;
  url: string;
}

function resolveApiTarget(input: RequestInfo | URL, apiOrigin: string | undefined): ApiTarget {
  if (typeof input === 'string') {
    if (input.startsWith('/api/')) {
      return { isApi: true, url: apiOrigin ? apiOrigin + input : input };
    }
    const parsed = tryParseUrl(input);
    if (parsed && isLocalApiUrl(parsed, apiOrigin)) {
      return { isApi: true, url: input };
    }
    return { isApi: false, url: input };
  }

  const parsed = input instanceof URL ? input : tryParseUrl(input.url, window.location.origin);
  if (parsed && isLocalApiUrl(parsed, apiOrigin)) {
    const original = input instanceof URL ? input.href : input.url;
    if (apiOrigin && (parsed.origin === window.location.origin || parsed.protocol === 'file:')) {
      return { isApi: true, url: apiOrigin + parsed.pathname + parsed.search + parsed.hash };
    }
    return { isApi: true, url: original };
  }
  return { isApi: false, url: input instanceof URL ? input.href : input.url };
}

function tryParseUrl(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

function isLocalApiUrl(url: URL, apiOrigin: string | undefined): boolean {
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.origin === window.location.origin || url.protocol === 'file:') return true;
  if (apiOrigin) {
    const api = tryParseUrl(apiOrigin);
    if (api && url.origin === api.origin) return true;
  }
  return false;
}
