/**
 * Error-envelope coverage meta-test — fail-on-any-occurrence mode.
 *
 * Mirrors the precedent #20 / `attribution-sweep-coverage.test.ts` style:
 * static source scan over `api-extension.ts` plus every lifted handler source
 * (`skills-sh-handlers.ts`, `http/*-routes.ts` — see `HANDLER_SOURCES`),
 * enforcing that
 *
 *   1. Every handler emits errors via `errorResponse(...)` and never via an
 *      inline `json(res, NNN, { ok: false, ... })` envelope.
 *   2. No handler emits an inline `json(res, NNN, { ok: true, ... })` success
 *      wrapper either (the `ok: true` wrapper is dropped from success bodies).
 *   3. No handler emits a bare `json(res, 2xx, ...)` success body — every
 *      success emit must flow through `successResponse(...)` so the
 *      schema-vs-server drift class is closed structurally at the wire
 *      boundary regardless of fixture coverage.
 *
 * Failure mode: file:line + handler name + the offending pattern.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractRouteHandlerNames,
  HANDLER_RUN_END_NEEDLES,
  listNativeRouteFiles,
} from '../native-route-files.test-helper.ts';

const SERVER_SRC = join(import.meta.dirname, '../../../server/src');
const HANDLER_SOURCES = [
  'api-extension.ts',
  'skills-sh-handlers.ts',
  ...listNativeRouteFiles(SERVER_SRC),
].map((file) => ({
  file,
  text: readFileSync(join(SERVER_SRC, file), 'utf8'),
}));
const source = HANDLER_SOURCES[0]?.text ?? '';

function extractRouteRecordHandlerNames(): string[] {
  return HANDLER_SOURCES.flatMap(({ text }) => extractRouteHandlerNames(text));
}

function listAllHandlers(): string[] {
  const all = HANDLER_SOURCES.map((h) => h.text).join('\n');
  const fnNames = [...all.matchAll(/async function (handle\w+)\(/g)].map((m) => m[1]);
  const wrapperNames = [...all.matchAll(/const (handle\w+) = withValidation\(/g)].map((m) => m[1]);
  const routerNames = [...all.matchAll(/const (handle\w+) = methodRouter\(/g)].map((m) => m[1]);
  const innerNames = new Set(
    wrapperNames.map((wrapper) => `${wrapper}Inner`).filter((inner) => fnNames.includes(inner)),
  );
  return Array.from(new Set([...fnNames, ...wrapperNames, ...routerNames])).filter(
    (n) => !innerNames.has(n),
  );
}

function extractHandlerBody(name: string): string | null {
  const fnDecl = `async function ${name}(`;
  const constDecl = `const ${name} = withValidation(`;
  const routerDecl = `const ${name} = methodRouter(`;
  const owner =
    HANDLER_SOURCES.find(
      (h) => h.text.includes(fnDecl) || h.text.includes(constDecl) || h.text.includes(routerDecl),
    )?.text ?? source;
  const fnIdx = owner.indexOf(fnDecl);
  const constIdx = owner.indexOf(constDecl);
  const routerIdx = owner.indexOf(routerDecl);
  let start = -1;
  if (fnIdx !== -1) start = fnIdx;
  else if (constIdx !== -1) start = constIdx;
  else if (routerIdx !== -1) start = routerIdx;
  if (start === -1) return null;

  const innerName = `${name}Inner`;
  const innerDecl = `\n  async function ${innerName}(`;
  const innerIdx = owner.indexOf(innerDecl, start + 1);
  const searchFrom = innerIdx === -1 ? start + 1 : innerIdx + 1;
  const nextFn = owner.indexOf('\n  async function handle', searchFrom);
  const nextConst = owner.indexOf('\n  const handle', searchFrom);
  const nextRoutes = HANDLER_RUN_END_NEEDLES.map((needle) => owner.indexOf(needle, searchFrom));
  const nextReturn = owner.indexOf('\n  return {', searchFrom);
  const candidates = [nextFn, nextConst, ...nextRoutes, nextReturn].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return owner.slice(start, next === -1 ? owner.length : next);
}

const INLINE_ERROR_RE = /json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*false\b/;
const INLINE_SUCCESS_WRAPPER_RE = /json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*true\b/;
const INLINE_BARE_SUCCESS_RE = /\bjson\(\s*res\s*,\s*2[0-9]{2}\s*,/;
const NON_JSON_LITERAL_CT_RE =
  /['"]Content-Type['"]\s*:\s*['"](?!application\/json['"])([^'"]+)['"]/;
const NON_JSON_VARIABLE_CT_RE = /['"]Content-Type['"]\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]/;
const STREAM_AUTH_DELEGATION_RE = /\bstreamAuthFlow\(\s*\{/;
function isNonJsonEmit(body: string): boolean {
  if (STREAM_AUTH_DELEGATION_RE.test(body)) return true;
  if (!/res\.writeHead\(/.test(body)) return false;
  if (NON_JSON_LITERAL_CT_RE.test(body)) return true;
  if (NON_JSON_VARIABLE_CT_RE.test(body) && /pipeline\(|res\.write\(/.test(body)) return true;
  return false;
}
const DISPATCHER_RE = /(?:return|await)\s+handle\w+\(\s*req\s*,\s*res\b/;

const SHARED_SUCCESS_SPINE_NAME = 'respondSkillImport';
const SHARED_SUCCESS_SPINE_RE = new RegExp(`\\b${SHARED_SUCCESS_SPINE_NAME}\\(\\s*res\\b`);

type EmitClass = 'json' | 'non-json' | 'dispatcher';

function classifyHandlerEmit(body: string): EmitClass {
  if (isNonJsonEmit(body)) return 'non-json';
  if (body.includes('= methodRouter(')) return 'dispatcher';
  if (DISPATCHER_RE.test(body) && !body.includes('successResponse(')) {
    return 'dispatcher';
  }
  return 'json';
}

describe('error envelope coverage (FR17, D36 a) — fail-on-any-occurrence', () => {
  test('handler-discovery regex finds at least the expected baseline (anti-vacuousness)', () => {
    expect(listAllHandlers().length).toBeGreaterThanOrEqual(65);
  });

  test('handler discovery covers every entry in the route table (cross-check)', () => {
    const routeRecordHandlerNames = extractRouteRecordHandlerNames();
    expect(routeRecordHandlerNames.length).toBeGreaterThan(0);
    const discovered = new Set(listAllHandlers());
    const missingFromDiscovery = routeRecordHandlerNames.filter(
      (name): name is string => !!name && !discovered.has(name),
    );
    expect(missingFromDiscovery).toEqual([]);
  });

  test('every handler uses errorResponse and emits no inline { ok: false } envelopes', () => {
    const all = listAllHandlers();
    const failures: string[] = [];
    for (const name of all) {
      const body = extractHandlerBody(name);
      if (!body) {
        failures.push(
          `${name}: body not found in any handler source (${HANDLER_SOURCES.map((h) => h.file).join(', ')})`,
        );
        continue;
      }
      if (INLINE_ERROR_RE.test(body)) {
        failures.push(`${name}: contains inline json(res, NNN, { ok: false, ... }) envelope`);
      }
      if (INLINE_SUCCESS_WRAPPER_RE.test(body)) {
        failures.push(`${name}: contains inline json(res, NNN, { ok: true, ... }) success wrapper`);
      }
      if (INLINE_BARE_SUCCESS_RE.test(body)) {
        failures.push(
          `${name}: contains inline json(res, 2xx, ...) — must use successResponse(...)`,
        );
      }
      if (
        !body.includes('errorResponse(') &&
        !body.includes('catchErrors(') &&
        !body.includes('= methodRouter(') &&
        !STREAM_AUTH_DELEGATION_RE.test(body)
      ) {
        failures.push(`${name}: missing errorResponse(...) usage`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('every JSON-emitting handler uses successResponse(...)', () => {
    const all = listAllHandlers();
    const failures: string[] = [];
    const counts: Record<EmitClass, number> = { json: 0, 'non-json': 0, dispatcher: 0 };
    for (const name of all) {
      const body = extractHandlerBody(name);
      if (!body) continue;
      const cls = classifyHandlerEmit(body);
      counts[cls]++;
      if (
        cls === 'json' &&
        !body.includes('successResponse(') &&
        !SHARED_SUCCESS_SPINE_RE.test(body)
      ) {
        failures.push(
          `${name}: JSON-emitting handler missing successResponse(...) — every 2xx success body must flow through the helper`,
        );
      }
    }
    expect(failures).toEqual([]);
    expect(counts.json).toBeGreaterThanOrEqual(60);
    expect(counts['non-json']).toBeGreaterThanOrEqual(4);
    expect(counts.dispatcher).toBeGreaterThanOrEqual(3);
  });

  test('the shared success spine flows 2xx through successResponse (delegation is not a bypass)', () => {
    const spineDecl = new RegExp(`\\n {2}(?:async )?function ${SHARED_SUCCESS_SPINE_NAME}\\(`);
    const declMatch = spineDecl.exec(source);
    expect(declMatch).not.toBeNull();
    const start = declMatch?.index ?? -1;
    expect(start).toBeGreaterThan(-1);
    const afterStart = start + 1;
    const nextFn = source.indexOf('\n  async function ', afterStart);
    const nextSyncFn = source.indexOf('\n  function ', afterStart);
    const nextConst = source.indexOf('\n  const handle', afterStart);
    const bounds = [nextFn, nextSyncFn, nextConst].filter((i) => i !== -1);
    const end = bounds.length === 0 ? source.length : Math.min(...bounds);
    const spineBody = source.slice(start, end);
    expect(spineBody.includes('successResponse(')).toBe(true);
    expect(INLINE_ERROR_RE.test(spineBody)).toBe(false);
    expect(INLINE_SUCCESS_WRAPPER_RE.test(spineBody)).toBe(false);
    expect(INLINE_BARE_SUCCESS_RE.test(spineBody)).toBe(false);
  });

  test('zero inline { ok: false } envelopes in any handler source', () => {
    const matches = HANDLER_SOURCES.flatMap((h) =>
      [...h.text.matchAll(/json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*false\b/g)].map((m) => ({
        m,
        h,
      })),
    );
    if (matches.length > 0) {
      const locations = matches.map(({ m, h }) => {
        const lineNumber = h.text.slice(0, m.index ?? 0).split('\n').length;
        return `${h.file}:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero inline { ok: true } success wrappers in any handler source', () => {
    const matches = HANDLER_SOURCES.flatMap((h) =>
      [...h.text.matchAll(/json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*true\b/g)].map((m) => ({
        m,
        h,
      })),
    );
    if (matches.length > 0) {
      const locations = matches.map(({ m, h }) => {
        const lineNumber = h.text.slice(0, m.index ?? 0).split('\n').length;
        return `${h.file}:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero bare json(res, 2xx, ...) success emits in any handler source', () => {
    const matches = HANDLER_SOURCES.flatMap((h) =>
      [...h.text.matchAll(/\bjson\(\s*res\s*,\s*2[0-9]{2}\s*,/g)].map((m) => ({ m, h })),
    );
    if (matches.length > 0) {
      const locations = matches.map(({ m, h }) => {
        const lineNumber = h.text.slice(0, m.index ?? 0).split('\n').length;
        return `${h.file}:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero NDJSON `JSON.stringify({ ok: false, ... })` legacy envelope shapes in any handler source', () => {
    const matches = HANDLER_SOURCES.flatMap((h) =>
      [...h.text.matchAll(/JSON\.stringify\(\s*\{\s*ok:\s*false\b/g)].map((m) => ({ m, h })),
    );
    if (matches.length > 0) {
      const locations = matches.map(({ m, h }) => {
        const lineNumber = h.text.slice(0, m.index ?? 0).split('\n').length;
        return `${h.file}:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero NDJSON `JSON.stringify({ ok: true, ... })` legacy envelope shapes in any handler source', () => {
    const matches = HANDLER_SOURCES.flatMap((h) =>
      [...h.text.matchAll(/JSON\.stringify\(\s*\{\s*ok:\s*true\b/g)].map((m) => ({ m, h })),
    );
    if (matches.length > 0) {
      const locations = matches.map(({ m, h }) => {
        const lineNumber = h.text.slice(0, m.index ?? 0).split('\n').length;
        return `${h.file}:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });
});
