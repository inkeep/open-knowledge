import { vi } from 'vitest';

type ApiRoute = (url: URL) => Response;

export function stubApiRoutes(routes: Readonly<Record<string, ApiRoute>>): void {
  const passthrough = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const route = routes[url.pathname];
      if (route) return route(url);
      if (url.pathname.startsWith('/api/')) {
        throw new Error(`the test stubs no response for ${url.pathname}`);
      }
      return passthrough(input, init);
    },
  );
}
