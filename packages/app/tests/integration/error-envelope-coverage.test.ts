/**
 * Error-envelope coverage meta-test — fail-on-any-occurrence mode.
 *
 * Mirrors the precedent #20 / `attribution-sweep-coverage.test.ts` style:
 * static AST scan over `packages/server/src/api-extension.ts` enforcing that
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

const SERVER_SRC = join(import.meta.dirname, '../../../server/src');
/**
 * Route handlers do not all live in one file: the six skills.sh handlers sit in
 * `skills-sh-handlers.ts`, built by a factory the route table destructures. Every
 * scan below runs over each source, because a handler that moves out of
 * `api-extension.ts` would otherwise escape these rules silently rather than
 * failing anything.
 */
const HANDLER_SOURCES = [
  'api-extension.ts',
  'skills-sh-handlers.ts',
  'http/link-graph-routes.ts',
].map((file) => ({
  file,
  text: readFileSync(join(SERVER_SRC, file), 'utf8'),
}));
/** The route table and the shared success spine live in `api-extension.ts` only. */
const source = HANDLER_SOURCES[0]?.text ?? '';

function listAllHandlers(): string[] {
  // Handlers in `api-extension.ts` come in three shapes:
  //   (1) Legacy `async function handleX(...)` (read-only routes).
  //   (2) `const handleX = withValidation(Schema, handler, options)` —
  //       where `handler` may be an inline arrow function OR a named
  //       `handleXInner` function declared adjacent to the wrapper for
  //       streaming endpoints whose bodies are too long for inline form.
  //   (3) `const handleX = methodRouter({ GET: ..., PUT: ... }, options)` —
  //       verb dispatchers. The 405 fallback emits via `errorResponse(...)`
  //       inside the helper (unit-tested in `http/method-router.test.ts`);
  //       the per-verb handlers are scanned separately under their own names.
  // Inner functions co-located with a wrapper are excluded from the public
  // handler list — they are scanned as part of the parent's body slice via
  // `extractHandlerBody`.
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
  // Whichever source declares it; a lifted handler is not in `api-extension.ts`.
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

  // For wrappers that delegate to a named inner function (`const handleX =
  // withValidation(Schema, handleXInner, ...)`), the inner function lives
  // immediately after the wrapper and carries the actual handler body.
  // Skip past the inner declaration when searching for the next handler so
  // the inner body is included in the slice for `handleX`.
  const innerName = `${name}Inner`;
  const innerDecl = `\n  async function ${innerName}(`;
  const innerIdx = owner.indexOf(innerDecl, start + 1);
  const searchFrom = innerIdx === -1 ? start + 1 : innerIdx + 1;
  const nextFn = owner.indexOf('\n  async function handle', searchFrom);
  const nextConst = owner.indexOf('\n  const handle', searchFrom);
  // The last handler in the file has no successor — bound at the route table
  // declaration `\n  const routes:` so we don't accidentally fold the
  // onRequest extension (which itself uses `errorResponse(...)` for the
  // /api/* Origin gate) into the prior handler's slice.
  const nextRoutes = owner.indexOf('\n  const routes:', searchFrom);
  // The factory module ends its handler run at the returned record instead of
  // a route table, so bound on that too or the last handler swallows it.
  const nextReturn = owner.indexOf('\n  return {', searchFrom);
  const candidates = [nextFn, nextConst, nextRoutes, nextReturn].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return owner.slice(start, next === -1 ? owner.length : next);
}

const INLINE_ERROR_RE = /json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*false\b/;
const INLINE_SUCCESS_WRAPPER_RE = /json\(\s*res\s*,\s*\d+\s*,\s*\{\s*ok:\s*true\b/;
// Bare `json(res, 2xx, ...)` — every success body must flow through
// `successResponse(...)` so the schema-vs-server drift class is closed
// structurally at the wire boundary (no allowlist, fail-on-any).
const INLINE_BARE_SUCCESS_RE = /\bjson\(\s*res\s*,\s*2[0-9]{2}\s*,/;
// Non-application/json Content-Type writes — handlers that emit binary,
// text/markdown, or NDJSON streams cannot use `successResponse()` (which
// always emits application/json) and are exempt from the symmetric check
// below.
//
// Three shapes are detected:
//   (a) Literal non-application/json inside writeHead args:
//       `res.writeHead(NNN, { 'Content-Type': 'text/markdown' })`
//       (handleRescueGet, NDJSON streamers).
//   (b) Headers object built outside writeHead with a literal non-JSON
//       Content-Type, then passed to writeHead:
//       `const headers = { 'Content-Type': 'text/markdown' }; res.writeHead(200, headers);`
//   (c) Variable Content-Type fed to writeHead via a headers object —
//       handlers dynamically computing the type from input are necessarily
//       emitting binary/non-JSON since `application/json` would never be
//       variable (handleAsset uses `'Content-Type': contentType`). AND'd
//       with `pipeline(...)` or `res.write(...)` (binary-stream / streaming
//       pattern) so a hypothetical future handler that variable-set the
//       type to `application/json` and called `successResponse` separately
//       would still classify as `'json'`.
const NON_JSON_LITERAL_CT_RE =
  /['"]Content-Type['"]\s*:\s*['"](?!application\/json['"])([^'"]+)['"]/;
const NON_JSON_VARIABLE_CT_RE = /['"]Content-Type['"]\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]/;
//   (d) Delegation to the shared `streamAuthFlow(...)` emitter — the auth
//       sign-in handlers (`handleLocalOpAuthLogin`, `handleLocalOpAuthGhLogin`)
//       hand the response to a helper that owns the whole streaming lifecycle:
//       the `application/x-ndjson` writeHead, the RFC 9457 streaming error
//       envelope (`createStreamingErrorWriter`), and the 429
//       concurrent-operation `errorResponse(...)`. The handler body therefore
//       contains none of those emits itself; the helper is the emit surface.
const STREAM_AUTH_DELEGATION_RE = /\bstreamAuthFlow\(\s*\{/;
function isNonJsonEmit(body: string): boolean {
  if (STREAM_AUTH_DELEGATION_RE.test(body)) return true;
  if (!/res\.writeHead\(/.test(body)) return false;
  if (NON_JSON_LITERAL_CT_RE.test(body)) return true;
  if (NON_JSON_VARIABLE_CT_RE.test(body) && /pipeline\(|res\.write\(/.test(body)) return true;
  return false;
}
// Dispatcher detection — body delegates to a sibling `handleX(req, res, ...)`
// handler via `return` or `await`, then emits no success body of its own.
// `handleSearch` / `handleFolderConfig` / `handleTemplate` route by
// HTTP method; `handleSpawnCursorRoute` / `handleInstalledAgentsRoute`
// add a defensive try/catch around a sub-module handler. Both shapes
// satisfy this — the inner sibling handler emits the actual success body
// and is scanned separately under its own name.
const DISPATCHER_RE = /(?:return|await)\s+handle\w+\(\s*req\s*,\s*res\b/;

// Shared response spine: `respondSkillImport(res, ...)` is the common
// success+error emitter for the import and upload handlers — it flows the 2xx
// body through `successResponse(...)` itself (verified by the dedicated test
// below). A handler that delegates its success emit to the spine therefore
// satisfies the wire-boundary contract even though its own body has no literal
// `successResponse(` call, exactly like the `handle*(req, res)` dispatcher case.
const SHARED_SUCCESS_SPINE_NAME = 'respondSkillImport';
const SHARED_SUCCESS_SPINE_RE = new RegExp(`\\b${SHARED_SUCCESS_SPINE_NAME}\\(\\s*res\\b`);

type EmitClass = 'json' | 'non-json' | 'dispatcher';

/**
 * Classify how a handler emits its response body. The symmetric
 * `successResponse(...)` per-handler check below only fires on `'json'`
 * — the other classes are structurally exempt.
 *
 * - `'non-json'` if the body sets a `Content-Type` other than
 *   `application/json` via `res.writeHead(...)`. Binary assets
 *   (`handleAsset`), text/markdown (`handleRescueGet`), and
 *   `application/x-ndjson` streams (`handleLocalOpClone`,
 *   `handleLocalOpAuthLogin`, `handleLocalOpAuthRepos`) all match.
 * - `'dispatcher'` if the body delegates response handling to a sibling
 *   `handle\w+(req, res, ...)` and emits no `successResponse(` itself.
 *   The dispatcher's own emit paths are limited to `errorResponse(...)`
 *   for method-not-allowed / internal-error fallbacks; the delegated
 *   sibling handler is scanned separately under its own name.
 *   `handleSearch` / `handleFolderConfig` / `handleTemplate` route by
 *   HTTP method; `handleSpawnCursorRoute` / `handleInstalledAgentsRoute`
 *   wrap a sub-module handler in a defensive try/catch.
 * - `'json'` otherwise — must call `successResponse(...)` for every 2xx
 *   path. Schema-vs-server drift surfaces at the wire boundary regardless
 *   of fixture coverage (the helper runs `safeParse(body)` on every emit).
 */
function classifyHandlerEmit(body: string): EmitClass {
  if (isNonJsonEmit(body)) return 'non-json';
  // `methodRouter({...})` declarations are dispatchers by construction —
  // the per-verb handlers they reference emit the actual bodies and are
  // scanned separately; the 405 fallback lives inside the helper.
  if (body.includes('= methodRouter(')) return 'dispatcher';
  if (DISPATCHER_RE.test(body) && !body.includes('successResponse(')) {
    return 'dispatcher';
  }
  return 'json';
}

describe('error envelope coverage (FR17, D36 a) — fail-on-any-occurrence', () => {
  test('handler-discovery regex finds at least the expected baseline (anti-vacuousness)', () => {
    // Anti-vacuousness guard mirroring `exhaustiveness-coverage.test.ts`.
    // If `listAllHandlers` regex drifts (e.g. a new handler-declaration
    // shape) and returns 0 or a small number, the per-handler iteration
    // below would pass silently with an empty `failures` array. The current
    // handler count is ~70 — pin the floor at 65 so deletions of a few
    // don't false-alarm but a regex break (which would silently mute >7%
    // of handlers) does.
    expect(listAllHandlers().length).toBeGreaterThanOrEqual(65);
  });

  test('handler discovery covers every entry in the route table (cross-check)', () => {
    // Stronger anti-vacuousness guard: every `'/api/<path>': handle<X>`
    // entry in the route table at the bottom of `api-extension.ts` must
    // resolve to a handler the discovery regex finds. A novel handler
    // shape (e.g., `const handleFoo = someOtherWrapper(...)`) that the
    // baseline floor above happens to clear (because deletions elsewhere
    // offset the addition) would still trip this check, because the
    // route-table entry references a handler name the regex would miss.
    //
    // The route-table block is the single source of truth for which
    // handlers are HTTP-reachable; the meta-test's job is only valuable
    // if every reachable handler is scanned.
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
        // Names every source actually searched, so a lifted handler that goes
        // missing does not send the reader back to `api-extension.ts` alone.
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
      // `catchErrors(...)` routes handler throws through `errorResponse(...)`
      // internally, and `methodRouter(...)` emits its 405 fallback the same
      // way — both wrappers satisfy the sanctioned-emitter requirement for
      // handlers whose remaining body has no direct error emit of its own.
      // `streamAuthFlow` delegators likewise: every error emit (429
      // concurrency envelope, RFC 9457 streaming errors) lives inside the
      // shared helper, so the handler body legitimately contains no
      // `errorResponse(` call.
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
    // Symmetric to the errorResponse per-handler check above. Closes the
    // bypass class where a developer hand-rolls a 2xx via `res.writeHead(200,
    // { 'Content-Type': 'application/json' }) + res.end(JSON.stringify(...))`
    // — which the synchronous `INLINE_BARE_SUCCESS_RE` sweep can't see.
    //
    // `classifyHandlerEmit` exempts non-JSON-emitting handlers
    // (binary / text/markdown / NDJSON-streaming) and delegating dispatchers
    // (handleSearch / handleFolderConfig / handleTemplate / handleSpawnCursorRoute /
    // handleInstalledAgentsRoute) — see the function's docstring for the
    // structural discrimination rules and the per-class anti-vacuousness
    // floor below.
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
    // Anti-vacuousness floor: discrimination must split handlers across all
    // three classes. A regex break that drops every handler into one bucket
    // (e.g., NON_JSON_CONTENT_TYPE_RE matching the whole file) would make
    // the symmetric check above silently meaningless. Floors are conservative
    // (current counts at the time of writing: json ≈ 60, non-json ≈ 5,
    // dispatcher ≈ 5); a regex break that collapses any class to zero trips
    // here regardless of whether the symmetric check passed.
    expect(counts.json).toBeGreaterThanOrEqual(60);
    expect(counts['non-json']).toBeGreaterThanOrEqual(4);
    expect(counts.dispatcher).toBeGreaterThanOrEqual(3);
  });

  test('the shared success spine flows 2xx through successResponse (delegation is not a bypass)', () => {
    // The successResponse per-handler scan accepts a handler that delegates its
    // 2xx emit to `respondSkillImport(res, ...)` (the import/upload spine). That
    // delegation is only sound if the spine itself flows through
    // `successResponse(...)` and emits no inline `{ ok: false }` envelope — the
    // spine is NOT a `handle*` route handler, so the per-handler scans above
    // never see it. Pin it directly so the exemption can't silently rot.
    // The spine may be sync or async (it became sync when the acquisition half
    // split off into a pure `runSkillImport`), so both forms have to match — an
    // `async`-only probe would silently stop finding it and pass vacuously.
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
    // Whole-file sweep: catches inline literals outside per-handler bodies
    // (helper functions, the onRequest extension, route-table fallthroughs).
    // The per-handler scan above bounds at the `\n  const routes:` declaration
    // and would miss anything below; this assertion is the structural
    // backstop.
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
    // The `ok: true` wrapper is dropped from success bodies. Same whole-file
    // sweep as above: fail-on-any-occurrence.
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
    // Every success body MUST flow through `successResponse(...)` so the
    // schema-vs-server drift class is closed structurally at the wire
    // boundary. Whole-file sweep mirrors the `{ ok: false/true }` ratchets
    // above: catches inline literals outside per-handler bodies (helper
    // functions, the route table, the onRequest extension). The per-handler
    // scan above bounds at the `\n  const routes:` declaration and would
    // miss anything below; this assertion is the structural backstop.
    //
    // The inline `json()` helper itself was deleted — every
    // surviving emit goes through `successResponse` (success) or
    // `errorResponse` / `streamingProblemEvent` / `createStreamingErrorWriter`
    // (errors). A future regression that re-adds an inline `json(res, 2xx,
    // ...)` helper would surface here regardless of whether the regression
    // is inside a per-handler body or a shared utility.
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
    // Streaming endpoints (clone, auth-login, auth-repos) emit NDJSON via
    // `res.write(JSON.stringify({...}) + '\n')`. The two whole-file sweeps
    // above only catch the synchronous `json(res, ...)` shape — a future
    // regression that hand-rolls `JSON.stringify({ ok: false, error: '...' })`
    // through `res.write` would otherwise be invisible. The streaming
    // protocol's typed shape is `{ type: 'progress' | 'complete' | 'error',
    // ... }` and errors carry an RFC 9457 `problem` payload via
    // `streamingProblemEvent` / `createStreamingErrorWriter` — there is no
    // legitimate reason to emit `{ ok: false, ... }` JSON literals from
    // streaming or non-streaming code.
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
    // The `ok: true` wrapper is dropped from success bodies. Streaming
    // success events use `{ type: 'complete', ... }` (or `progress`) — a
    // future regression into the legacy wrapped shape is invisible to the
    // synchronous `json(res, ...)` sweep.
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
