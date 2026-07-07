/**
 * Canonical supported markdown-family file extensions for content files.
 *
 * THE single source of truth for the doc-extension list, shared across the
 * public/private boundary: the server's extension registry, the agent-write
 * HTTP schema, and the MCP CRUD-verb tool schemas all import from here so the
 * accepted set can never drift between layers.
 *
 * Ordered by precedence — earlier entries win when the same docName exists
 * with multiple extensions on disk. Precedence matches the industry convention
 * (Next.js, Astro, Fumadocs): `.mdx` is a strict superset of `.md`, so a
 * co-located `.mdx` is presumed to intentionally override the `.md`.
 *
 * Lives in core (not server) because core-layer schemas (`agent-write.ts`)
 * must reference it and core cannot import from server.
 */
export const SUPPORTED_DOC_EXTENSIONS = ['.mdx', '.md'] as const;

export type DocExtension = (typeof SUPPORTED_DOC_EXTENSIONS)[number];

/** Extension a new doc lands as when the caller doesn't specify one. */
export const DEFAULT_DOC_EXTENSION: DocExtension = '.md';
