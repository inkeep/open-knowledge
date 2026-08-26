import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Handler-run END boundaries for the guards' per-handler body extraction:
 * whichever route-record declaration shape follows the last handler in a
 * source (an annotated record — `api-extension.ts` and the pre-helper
 * factories — a `satisfies` literal, or the record passed inline to
 * `createApiRouteGroup(...)`). These needles are
 * indentation-sensitive by contract — they must match the two-space
 * module-function body layout of `api-extension.ts` and the `http/*-routes.ts`
 * factories, and exist ONLY for that boundary role; route-record NAME
 * extraction matches the bindings directly and needs no anchors.
 */
export const HANDLER_RUN_END_NEEDLES = [
  '\n  const routes:',
  '\n  const routes =',
  '\n  return createApiRouteGroup(',
] as const;

/**
 * Every `'/api/…': handle<X>` binding in a source, whatever the record's
 * declaration shape or position — the quoted path key is what distinguishes a
 * route-record binding from a `methodRouter` verb map (`GET: handleFoo`),
 * so no slice anchors are needed. Deliberately out of scope — closure- or
 * assignment-bound, never record-bound, so they must be categorized in the
 * guards by hand: handlers reached through a `dynamic.dispatch` leg or a
 * hand-rolled `resolve` closure, and bracket assignments like the
 * `enableTestRoutes` block's `routes['/api/test-reset'] = ...`.
 */
export function extractRouteHandlerNames(text: string): string[] {
  return [...text.matchAll(/'\/api\/[^']*':\s*(handle\w+)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/**
 * Every native route-group factory under `server/src/http`, as `http/<file>`
 * paths relative to `server/src`. The single discovery point for the guards
 * that must scan ALL groups (error-envelope, attribution-sweep, conflict-gate,
 * native-route-unit-reachability): a new `http/*-routes.ts` group joins every
 * scan without a per-PR list edit, so a forgotten edit cannot silently shrink
 * a guard's coverage.
 */
export function listNativeRouteFiles(serverSrcRoot: string): string[] {
  return readdirSync(join(serverSrcRoot, 'http'))
    .filter((entry) => entry.endsWith('-routes.ts') && !entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => `http/${entry}`);
}
