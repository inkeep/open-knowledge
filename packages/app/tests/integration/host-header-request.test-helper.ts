import { request } from 'node:http';

export interface HostHeaderResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Issue an HTTP request that carries an explicit (forged) `Host` header via
 * node:http, returning a minimal fetch-`Response`-shaped object.
 *
 * The global `fetch` (undici) silently drops a caller-set `Host` header and
 * sends the real target authority, so it cannot exercise the server's
 * host-not-allowed / DNS-rebinding guard — the request always looks loopback.
 * node:http honors the header verbatim, which is what these guard tests need.
 */
export function fetchWithHostHeader(
  url: string,
  host: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<HostHeaderResponse> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? 'GET',
        headers: { Host: host, ...init.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (name: string) => {
                const value = res.headers[name.toLowerCase()];
                return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
              },
            },
            json: async () => JSON.parse(bodyText),
            text: async () => bodyText,
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
