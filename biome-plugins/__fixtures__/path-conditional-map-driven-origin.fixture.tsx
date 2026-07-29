// FIXTURE — drives `path-conditional-map-driven-origin.test.ts` via shell-out
// to `biome check`. Not part of the main lint (override scope keeps the rule
// off this fixture's path under normal `pnpm run lint`; the test explicitly
// invokes biome on this file path).
//
// 7 positive cases (deliberate violations — plugin must fire) + 3 negative
// cases (sanctioned shapes that must NOT fire). Exact-equality (`toBe(7)`) in
// the test catches both false-negative regressions (drop below 7) and
// false-positive widenings (above 7).
//
// The rule checks the ORIGIN ARGUMENT POSITION (the second argument), not
// "the call subtree contains the identifier anywhere". Positive7 + Negative3
// are the load-bearing pair: a callback body that mentions OBSERVER_SYNC_ORIGIN
// must NOT clear a call whose origin argument is missing/wrong (Positive7), and
// must NOT trip a call whose origin argument is correct (Negative3).

// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const doc: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const session: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const OBSERVER_SYNC_ORIGIN: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const SOME_OTHER_ORIGIN: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const current: any;

const noop = (): void => undefined;

// === Positive cases — must fire ===

// (1) Bare `doc.transact(fn)` — no origin at all.
export function Positive1(): void {
  doc.transact(noop);
}

// (2) Bare `session.doc.transact(fn)` via a different receiver — still bare.
export function Positive2(): void {
  session.doc.transact(noop);
}

// (3) 2-arg with a non-sanctioned origin identifier.
export function Positive3(): void {
  doc.transact(noop, SOME_OTHER_ORIGIN);
}

// (4) 2-arg with a string-literal origin (a common shortcut that bypasses the
//     typed allowlist).
export function Positive4(): void {
  doc.transact(noop, 'made-up-origin');
}

// (5) 2-arg using `session.origin` — the per-session origin used by non-observer
//     paths. Inside observer dispatch only `OBSERVER_SYNC_ORIGIN` is sanctioned,
//     so `session.origin` is a violation in observer scope.
export function Positive5(): void {
  doc.transact(noop, session.origin);
}

// (6) 3-arg form `(fn, origin, local)` with a wrong origin in the middle slot.
export function Positive6(): void {
  doc.transact(noop, SOME_OTHER_ORIGIN, true);
}

// (7) Nested-identifier: the callback body mentions OBSERVER_SYNC_ORIGIN but the
//     call itself is bare — no origin argument. The old `contains`-based rule
//     was falsely cleared by the nested mention; the argument-position rule
//     fires because the second argument is absent.
export function Positive7(): void {
  doc.transact(() => {
    if (current === OBSERVER_SYNC_ORIGIN) return;
    noop();
  });
}

// === Negative cases — must NOT fire ===

// (1) Sanctioned origin in the second position.
export function Negative1(): void {
  doc.transact(noop, OBSERVER_SYNC_ORIGIN);
}

// (2) 3-arg form with the sanctioned origin in the second position.
export function Negative2(): void {
  doc.transact(noop, OBSERVER_SYNC_ORIGIN, true);
}

// (3) Nested-identifier WITH the correct origin — mirrors the real
//     `server-observers.ts` drain shape: the callback references
//     OBSERVER_SYNC_ORIGIN and the second argument is OBSERVER_SYNC_ORIGIN.
//     Must NOT fire.
export function Negative3(): void {
  doc.transact(() => {
    if (current === OBSERVER_SYNC_ORIGIN) return;
    noop();
  }, OBSERVER_SYNC_ORIGIN);
}
