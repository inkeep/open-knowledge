/**
 * Moved to `@inkeep/open-knowledge-core/acp/permissive-mode` so the
 * permission-posture derivation (core) and this app share one detector —
 * the header badge and the composer's amber accent must never disagree
 * about the same mode. Re-exported here so app-side imports keep their
 * path.
 */

export { isPermissiveMode } from '@inkeep/open-knowledge-core/acp/permissive-mode';
