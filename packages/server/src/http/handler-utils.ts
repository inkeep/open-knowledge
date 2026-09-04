import type { IncomingMessage } from 'node:http';

export function parseQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '', 'http://localhost').searchParams;
}

export function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
