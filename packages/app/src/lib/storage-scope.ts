/**
 * Project scoping for the renderer's persistent storage names — the
 * implementation of `precedent #59`, which is the citable statement of the
 * rule. Home of the one thing every client storage surface has to obey, so a
 * new one adopts it instead of rediscovering the bug (`provider-pool.ts` used
 * to own this privately, which is why `replay-outbox.ts` shipped without it).
 */
import { fnv1aDigest } from '@inkeep/open-knowledge-core';

/**
 * Scope a client storage name to a single project.
 *
 * A packaged desktop window loads the renderer through `loadFile`, so every
 * project window shares the one `file://` origin (`webPreferences.partition`
 * is set only for slides windows). One name per origin therefore means one
 * name for EVERY open project, and whichever window wrote last decides what
 * the next cold boot reads back. For the branch claim that is load-bearing: a
 * window seeds `lastObservedBranch` from the shared key, claims a sibling
 * project's branch, and the server correctly rejects it — the doc wedges and
 * the red branch-mismatch banner goes up.
 *
 * `namespace` is the project's content dir, digested so no absolute home path
 * lands in storage. Nothing prunes: the pre-scoping unscoped names are left
 * behind once, and one scoped name accrues per project ever opened. Both are
 * bounded, which is why this ships without a migration — adopting the old
 * value would import the sibling-project state it removes. A null namespace
 * returns the bare name, which is correct for web hosts: those are served per
 * project on `http://127.0.0.1:<port>`, so the origin already isolates them.
 *
 * **The origin is shared by more than one surface, and this list is not a
 * gate.** The same cause has been mitigated independently several times over —
 * `localTabSessionKeyForMode` in `editor-tabs.ts` returns null for BOTH
 * editor and note windows so neither writes the shared key (editor tab state
 * persists through the desktop bridge instead, keyed per project; note
 * persists nothing), `dock-session-persistence.ts` routes through the main
 * process,
 * the pool's two localStorage keys route through here, and `replay-outbox.ts`
 * names its IndexedDB database through here. Others are still unscoped at the
 * time of writing (`ok-omnibar-recents-v1`, `ok-ask-ai-draft-v2`), which is
 * the point: a hand-kept list drifts, so treat this as illustrative and the
 * RULE above as the contract. A sweep test classifying every persistent
 * storage name as app-global-by-intent or project-scoped would make it a real
 * gate; until then a new surface is only as safe as its author's diligence.
 *
 * Scoping the ORIGIN instead (a per-project `webPreferences.partition`) was
 * considered and rejected: it silently bypasses the `defaultSession`-only
 * `webRequest` hooks and spellchecker config, forks genuinely app-global
 * prefs such as theme and language, and orphans every existing `ok-ydoc:*`
 * store.
 *
 * Applies to any name whose collision domain is the ORIGIN. The y-indexeddb
 * store in `client-persistence.ts` is deliberately not routed through here:
 * its name already carries the per-process `serverInstanceId`, and each
 * project runs its own Hocuspocus process, so that name cannot collide across
 * projects even without a project component.
 *
 * Named "key" from its localStorage origin; it now also composes IndexedDB
 * database NAMES (`replay-outbox.ts`). Read `baseKey` as "base storage name".
 */
export function scopedStorageKey(baseKey: string, namespace: string | null): string {
  // `null` only. An empty string is NOT a web host: it is what a window
  // opened without a project reports (the preload defaults `projectPath` to
  // `''`, and the navigator passes `--ok-project-path=` outright). Letting it
  // fall through to the bare key would put those windows on the shared
  // app-wide name; digesting it instead keeps them sharing only with each
  // other, which is the safe direction if one ever reaches a document store.
  if (namespace === null) return baseKey;
  return `${baseKey}:${projectDigest(namespace)}`;
}

/**
 * The project segment `scopedStorageKey` embeds.
 *
 * Exported so anything that has to be COMPARABLE to a scoped storage name —
 * telemetry correlating an event to a database, a test recomposing one —
 * derives it here rather than calling `fnv1aDigest` again. A second
 * derivation is equal only by coincidence: a salt, a truncation or a
 * different hash added here would silently stop matching it. Digesting is
 * also the privacy step (a raw namespace is an absolute path that can carry
 * the OS username), so keeping one definition keeps one place to audit.
 *
 * Note this is the SEGMENT, not the composition: `scopedStorageKey` above
 * decides how it is joined to a base name, and a caller reconstructing a full
 * name must go through that rather than concatenating this itself.
 */
export function projectDigest(namespace: string): string {
  return fnv1aDigest(namespace);
}
