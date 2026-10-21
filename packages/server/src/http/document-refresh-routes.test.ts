import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, parseProblem } from '../composition-rig.test-helper.ts';
import type { RefreshDocumentsFromDisk } from '../document-refresh.ts';
import { buildIngressPolicy } from '../ingress-policy.ts';
import { loggerFactory } from '../logger.ts';
import { createApiRequestPipeline } from './api-pipeline.ts';
import { createDocumentRefreshRoutes } from './document-refresh-routes.ts';

const REFRESH_PATH = '/api/documents/refresh';

function makeRequest(body: unknown, method = 'POST'): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from(JSON.stringify(body)));
  req.push(null);
  req.method = method;
  req.url = REFRESH_PATH;
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1' });
  return req;
}

async function dispatch(refresh: RefreshDocumentsFromDisk, body: unknown, method?: string) {
  const group = createDocumentRefreshRoutes({ refreshDocumentsFromDisk: refresh });
  const pipeline = createApiRequestPipeline({
    log: loggerFactory.getLogger('document-refresh-routes-test'),
    policy: buildIngressPolicy({}),
    table: group.table,
  });
  const { res, captured } = makeCaptureRes();
  const handled = await pipeline(makeRequest(body, method), res);
  return { handled, captured };
}

describe('createDocumentRefreshRoutes table', () => {
  test('owns only the refresh path and classifies it as mutating', () => {
    const group = createDocumentRefreshRoutes({
      refreshDocumentsFromDisk: async () => ({ checked: 0, found: 0 }),
    });
    expect(group.paths).toEqual([REFRESH_PATH]);
    expect(group.table.resolve(REFRESH_PATH)?.dispatch).toBeDefined();
    expect(group.table.isMutating(REFRESH_PATH)).toBe(true);
    for (const path of ['/api/documents', '/api/documents/refresh/', '/api/documents/other']) {
      expect(group.table.resolve(path), path).toBeNull();
      expect(group.table.isMutating(path), path).toBe(false);
    }
  });

  test('re-reads the named documents as a focus re-read and answers with what it found', async () => {
    const refresh = vi.fn<RefreshDocumentsFromDisk>(async () => ({ checked: 2, found: 1 }));
    const { handled, captured } = await dispatch(refresh, { docNames: ['a', 'folder/b'] });

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ checked: 2, found: 1 });
    expect(refresh).toHaveBeenCalledWith(['a', 'folder/b'], 'focus');
  });

  test('a failed re-read answers with a problem and no success body', async () => {
    const refresh = vi.fn<RefreshDocumentsFromDisk>(async () => {
      throw new Error('disk unavailable');
    });
    const { captured } = await dispatch(refresh, { docNames: ['a'] });

    expect(captured.status).toBe(500);
    expect(parseProblem(captured.body).type).toBe('urn:ok:error:internal-server-error');
  });
});
