/**
 * Subkey under a doc's `lifecycle` Y.Map that holds the per-doc lineage
 * epoch. The server mints a fresh epoch into this slot inside
 * `persistence.ts`'s `onLoadDocument` seed transact; the server's
 * `doc-lineage-guard` reads it on reconnect, and the client `provider-pool`
 * records it after sync and claims it on every reconnect. Shared from this
 * browser+Node module so the mint, the guard read, and the two client
 * record/claim sites all key off one literal across packages — a typo or
 * rename at any single site cannot silently disable the lineage fence.
 */
export const LINEAGE_EPOCH_KEY = 'epoch';
