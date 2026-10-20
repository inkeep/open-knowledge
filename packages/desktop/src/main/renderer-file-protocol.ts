import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppShellPolicies } from '@inkeep/open-knowledge-core/server';
import { net, type Protocol } from 'electron';
import { getLogger } from './desktop-logger.ts';

const MAX_REMEMBERED_WARNINGS = 256;

function causeOf(err: unknown): string {
  if (err === undefined) return '';
  return err instanceof Error ? err.message : String(err);
}

export function installRendererFileProtocol(protocol: Protocol, rendererRoot: string): void {
  const root = resolve(rendererRoot);
  const log = getLogger('renderer-file-protocol');
  const warned = new Set<string>();

  function warnOnce(key: string, context: Record<string, unknown>, message: string): void {
    if (warned.has(key)) return;
    if (warned.size >= MAX_REMEMBERED_WARNINGS) warned.clear();
    warned.add(key);
    log.warn({ root, ...context }, message);
  }

  const policyFor = createAppShellPolicies(root, ({ err, file }, message) =>
    warnOnce([message, file, causeOf(err)].join('\u0000'), { err, file }, message),
  );

  function refuse(status: number, target: string, reason: string, err?: unknown): Response {
    warnOnce(
      [reason, target, causeOf(err)].join('\u0000'),
      { err, target, reason },
      'refused a renderer file request',
    );
    return new Response(null, { status });
  }

  protocol.handle('file', async (request) => {
    let file: string;
    try {
      file = resolve(fileURLToPath(request.url));
    } catch (err) {
      return refuse(400, request.url, 'not a file path', err);
    }
    if (!file.startsWith(root + sep)) return refuse(404, file, 'outside the renderer bundle');
    let served: Stats;
    try {
      served = await stat(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return refuse(404, file, 'no such file');
      return refuse(500, file, 'could not stat the file', err);
    }
    if (served.isDirectory()) return refuse(404, file, 'a folder');
    let response: Response;
    try {
      response = await net.fetch(request, { bypassCustomProtocolHandlers: true });
    } catch (err) {
      return refuse(500, file, 'could not load the file', err);
    }
    const policy = response.ok ? policyFor({ file, stats: served }) : undefined;
    if (policy === undefined) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', policy);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
