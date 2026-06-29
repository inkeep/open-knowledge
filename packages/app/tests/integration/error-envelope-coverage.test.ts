import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_EXT_PATH = join(import.meta.dirname, '../../../server/src/api-extension.ts');
const source = readFileSync(API_EXT_PATH, 'utf8');

function listAllHandlers(): string[] {
  const fnNames = [...source.matchAll(/async function (handle\w+)\(/g)].map((m) => m[1]);
  const wrapperNames = [...source.matchAll(/const (handle\w+) = withValidation\(/g)].map(
    (m) => m[1],
  );
  const innerNames = new Set(
    wrapperNames.map((wrapper) => `${wrapper}Inner`).filter((inner) => fnNames.includes(inner)),
  );
  return Array.from(new Set([...fnNames, ...wrapperNames])).filter((n) => !innerNames.has(n));
}

function extractHandlerBody(name: string): string | null {
  const fnDecl = `async function ${name}(`;
  const constDecl = `const ${name} = withValidation(`;
  const fnIdx = source.indexOf(fnDecl);
  const constIdx = source.indexOf(constDecl);
  let start = -1;
  if (fnIdx !== -1) start = fnIdx;
  else if (constIdx !== -1) start = constIdx;
  if (start === -1) return null;

  const innerName = `${name}Inner`;
  const innerDecl = `\n  async function ${innerName}(`;
  const innerIdx = source.indexOf(innerDecl, start + 1);
  const searchFrom = innerIdx === -1 ? start + 1 : innerIdx + 1;
  const nextFn = source.indexOf('\n  async function handle', searchFrom);
  const nextConst = source.indexOf('\n  const handle', searchFrom);
  const nextRoutes = source.indexOf('\n  const routes:', searchFrom);
  const candidates = [nextFn, nextConst, nextRoutes].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return source.slice(start, next === -1 ? source.length : next);
}

const INLINE_ERROR_RE = /json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*false\b/;
const INLINE_SUCCESS_WRAPPER_RE = /json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*true\b/;
const INLINE_BARE_SUCCESS_RE = /\bjson\(\s*res\s*,\s*2[0-9]{2}\s*,/;
const NON_JSON_LITERAL_CT_RE =
  /['"]Content-Type['"]\s*:\s*['"](?!application\/json['"])([^'"]+)['"]/;
const NON_JSON_VARIABLE_CT_RE = /['"]Content-Type['"]\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]/;
function isNonJsonEmit(body: string): boolean {
  if (!/res\.writeHead\(/.test(body)) return false;
  if (NON_JSON_LITERAL_CT_RE.test(body)) return true;
  if (NON_JSON_VARIABLE_CT_RE.test(body) && /pipeline\(|res\.write\(/.test(body)) return true;
  return false;
}
const DISPATCHER_RE = /(?:return|await)\s+handle\w+\(\s*req\s*,\s*res\b/;

type EmitClass = 'json' | 'non-json' | 'dispatcher';

function classifyHandlerEmit(body: string): EmitClass {
  if (isNonJsonEmit(body)) return 'non-json';
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
    const routeTableHandlerNames = [...source.matchAll(/'\/api\/[^']*':\s+(handle\w+),?$/gm)].map(
      (m) => m[1],
    );
    expect(routeTableHandlerNames.length).toBeGreaterThan(0);
    const discovered = new Set(listAllHandlers());
    const missingFromDiscovery = routeTableHandlerNames.filter(
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
        failures.push(`${name}: not found in api-extension.ts`);
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
      if (!body.includes('errorResponse(')) {
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
      if (cls === 'json' && !body.includes('successResponse(')) {
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

  test('zero inline { ok: false } envelopes anywhere in api-extension.ts', () => {
    const matches = [...source.matchAll(/json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*false\b/g)];
    if (matches.length > 0) {
      const locations = matches.map((m) => {
        const lineNumber = source.slice(0, m.index ?? 0).split('\n').length;
        return `api-extension.ts:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero inline { ok: true } success wrappers anywhere in api-extension.ts', () => {
    const matches = [...source.matchAll(/json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*true\b/g)];
    if (matches.length > 0) {
      const locations = matches.map((m) => {
        const lineNumber = source.slice(0, m.index ?? 0).split('\n').length;
        return `api-extension.ts:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero bare json(res, 2xx, ...) success emits anywhere in api-extension.ts', () => {
    const matches = [...source.matchAll(/\bjson\(\s*res\s*,\s*2[0-9]{2}\s*,/g)];
    if (matches.length > 0) {
      const locations = matches.map((m) => {
        const lineNumber = source.slice(0, m.index ?? 0).split('\n').length;
        return `api-extension.ts:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero NDJSON `JSON.stringify({ ok: false, ... })` legacy envelope shapes anywhere in api-extension.ts', () => {
    const matches = [...source.matchAll(/JSON\.stringify\(\s*\{\s*ok:\s*false\b/g)];
    if (matches.length > 0) {
      const locations = matches.map((m) => {
        const lineNumber = source.slice(0, m.index ?? 0).split('\n').length;
        return `api-extension.ts:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });

  test('zero NDJSON `JSON.stringify({ ok: true, ... })` legacy envelope shapes anywhere in api-extension.ts', () => {
    const matches = [...source.matchAll(/JSON\.stringify\(\s*\{\s*ok:\s*true\b/g)];
    if (matches.length > 0) {
      const locations = matches.map((m) => {
        const lineNumber = source.slice(0, m.index ?? 0).split('\n').length;
        return `api-extension.ts:${lineNumber}`;
      });
      expect(locations).toEqual([]);
    }
    expect(matches.length).toBe(0);
  });
});
