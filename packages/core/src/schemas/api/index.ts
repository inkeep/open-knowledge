/**
 * Barrel re-export for the per-cluster API schemas.
 *
 * Canonical Zod schemas for HTTP API response shapes served by
 * `packages/server/src/api-extension.ts`. Schemas live in `packages/core`
 * (browser-safe) so both server route handlers and client consumers
 * (`DocumentContext`, `test-harness`) import the same shape — single source
 * of truth, no cross-process drift, no Node deps leaking into the browser
 * bundle.
 *
 * `.loose()` preserves unknown fields
 * for forward-compat; inferred types via `z.infer`. Every exported schema
 * asserts conformance via inline `satisfies StandardSchemaV1<unknown, T>`
 * so non-Zod consumers (form libraries, validators) can interop without
 * binding to Zod directly. Zod v4 schemas natively expose `~standard`.
 *
 * The cluster split mirrors the original monolithic api.ts cluster
 * comments (A-I) — kept stable so future schema additions land in the
 * matching cluster file rather than accreting into a kitchen-sink module.
 */

export * from './_envelope.ts';
export * from './agent-write.ts';
export * from './client-logs.ts';
export * from './document-read.ts';
export * from './embed-detect.ts';
export * from './history.ts';
export * from './links-orphans.ts';
export * from './local-op.ts';
export * from './metrics.ts';
export * from './pages.ts';
export * from './share.ts';
export * from './sync-seed.ts';
export * from './tags-search.ts';
