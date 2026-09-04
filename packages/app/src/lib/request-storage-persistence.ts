export async function requestStoragePersistence(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<boolean> {
  try {
    const storage = nav?.storage;
    if (storage === undefined || typeof storage.persist !== 'function') return false;
    return await storage.persist();
  } catch {
    return false;
  }
}
