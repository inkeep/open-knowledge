import { describe, expect, test } from 'bun:test';
import { computeDevApiConfigResponse } from './api-config-handler.ts';

describe('computeDevApiConfigResponse', () => {
  test('GET on a bound port returns 200 + collab URL + port', () => {
    const res = computeDevApiConfigResponse('GET', 5173);
    expect(res).not.toBeNull();
    if (!res) return;
    expect(res.status).toBe(200);
    expect(res.omitBody).toBe(false);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      collabUrl: 'ws://localhost:5173/collab',
      previewUrl: null,
      port: 5173,
      singleFile: false,
    });
  });

  test('singleFile flag rides the dev response when an ephemeral session is active', () => {
    const res = computeDevApiConfigResponse('GET', 5173, true);
    expect(res).not.toBeNull();
    if (!res) return;
    expect(JSON.parse(res.body).singleFile).toBe(true);
  });

  test('GET with port=0 (pre-listen) returns collabUrl=null', () => {
    const res = computeDevApiConfigResponse('GET', 0);
    expect(res).not.toBeNull();
    if (!res) return;
    const body = JSON.parse(res.body);
    expect(body.collabUrl).toBeNull();
    expect(body.port).toBe(0);
  });

  test('response headers match ok ui contract', () => {
    const res = computeDevApiConfigResponse('GET', 5173);
    expect(res?.headers).toEqual({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  test('HEAD omits the body but keeps status + headers', () => {
    const res = computeDevApiConfigResponse('HEAD', 5173);
    expect(res).not.toBeNull();
    if (!res) return;
    expect(res.status).toBe(200);
    expect(res.omitBody).toBe(true);
    expect(res.headers['Content-Type']).toBe('application/json');
  });

  test('POST / PUT / DELETE / PATCH / undefined return null so caller falls through to 404', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', undefined]) {
      expect(computeDevApiConfigResponse(method, 5173)).toBeNull();
    }
  });
});
