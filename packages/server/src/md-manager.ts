/**
 * Shared server-side MarkdownManager and schema.
 *
 * Before this module, the server package instantiated five independent
 * `new MarkdownManager({ extensions: sharedExtensions })` instances across
 * `server-factory.ts`, `persistence.ts`, `backlink-index.ts`, `agent-sessions.ts`,
 * and `external-change.ts`, plus three independent `getSchema(sharedExtensions)`
 * calls. The constructions are identical — every site passes the same
 * `sharedExtensions` source of truth — so the independent instances produce
 * identical schema and handler tables.
 *
 * MarkdownManager is stateless with respect to document content: it holds a
 * pre-built unified pipeline factory (schema + handler tables), so sharing a
 * single instance is strictly better than instantiating per module:
 *   - eliminates redundant `getSchema` work (PM schema build is non-trivial)
 *   - fewer handler-table allocations
 *   - one import surface for any future server-side factory overrides
 *
 * Import from here anywhere in `packages/server/`. Tests that need an isolated
 * instance may still construct their own (the class is re-exported from
 * `@inkeep/open-knowledge-core`); this module is the production singleton.
 */
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';

/** Shared server-side MarkdownManager instance. */
export const mdManager = new MarkdownManager({ extensions: sharedExtensions });

/** Shared server-side ProseMirror schema, derived from sharedExtensions. */
export const schema = getSchema(sharedExtensions);
