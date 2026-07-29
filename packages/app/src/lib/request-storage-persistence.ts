/**
 * Ask the browser once, at app init, to make this origin's storage
 * persistent so the IndexedDB CRDT cache is less likely to be evicted under
 * storage pressure.
 *
 * Best-effort and non-authoritative: the server stays the source of truth, so
 * this only hardens the local cache — it does not change the durability
 * posture. `navigator.storage.persist` is a heuristic on Safari, and the API
 * is absent in some environments (older engines, jsdom, insecure contexts),
 * where the call is skipped. The `navigator` is a parameter so tests can drive
 * the present / absent / rejecting cases without a global stub.
 */
export async function requestStoragePersistence(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<boolean> {
  try {
    const storage = nav?.storage;
    if (storage === undefined || typeof storage.persist !== 'function') return false;
    return await storage.persist();
  } catch {
    // Some engines throw (rather than resolve false) when persistence is
    // unavailable or the context is insecure. A hardening request that fails
    // must never break app init.
    return false;
  }
}
