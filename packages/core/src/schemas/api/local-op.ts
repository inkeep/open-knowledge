/**
 * Cluster G: LocalOp + auth handlers.
 *
 * Six handlers: `handleLocalOpOkInit`, `handleLocalOpAuthLogin`,
 * `handleLocalOpAuthStatus`, `handleLocalOpAuthRepos`,
 * `handleLocalOpAuthSignout`, `handleLocalOpAuthSetIdentity`. Login + repos
 * are NDJSON streaming endpoints — the streaming pattern applies (pre-stream
 * errors emit
 * `application/problem+json`; mid-stream errors emit a typed `{ type:
 * 'error', problem: ProblemDetails }` event). set-identity
 * / ok-init / signout / status are non-streaming.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/**
 * Request body for `POST /api/local-op/ok-init`. The share-receive
 * consent dialog calls this when the user opts into initializing a
 * CLI-managed worktree that lacks `.ok/config.yml`. `projectPath` MUST be
 * an absolute path inside a git working tree; the server gates with the
 * same `isAbsolute` + git-dir-kind checks the candidate-selection
 * algorithm uses upstream.
 */
export const LocalOpOkInitRequestSchema = z
  .object({
    projectPath: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpOkInitRequest = z.infer<typeof LocalOpOkInitRequestSchema>;

/**
 * Discriminator for `POST /api/local-op/ok-init` failure mode.
 *
 * - `'not-a-git-worktree'` — `projectPath` has no `.git` directory or
 *   pointer. The endpoint refuses to scaffold `.ok/` outside a git tree.
 * - `'init-failed'` — symlink-guard tripped, filesystem permission error,
 *   or some other filesystem failure during scaffold writes.
 */
export const LocalOpOkInitFailureReasonSchema = z.enum([
  'not-a-git-worktree',
  'init-failed',
]) satisfies StandardSchemaV1;
export type LocalOpOkInitFailureReason = z.infer<typeof LocalOpOkInitFailureReasonSchema>;

/**
 * Response body for `POST /api/local-op/ok-init`, discriminated on `ok`.
 *
 * Both branches return HTTP 200; protocol-level errors (400 malformed
 * body, 500 unexpected) use the standard RFC 9457 problem+json envelope.
 *
 * On success: `projectPath` is the realpath-collapsed path that was
 * scaffolded (callers compare against their input to detect symlink
 * resolution). The endpoint is idempotent — calling on an already-OK
 * project returns `{ok: true}` without rewriting `config.yml`.
 *
 * On failure: `reason` discriminates the user-facing recovery path
 * (not-a-git-worktree → re-pick a different folder; init-failed →
 * surface the message and let the user inspect manually).
 */
export const LocalOpOkInitResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      projectPath: z.string().min(1),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      reason: LocalOpOkInitFailureReasonSchema,
      message: z.string().min(1),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type LocalOpOkInitResponse = z.infer<typeof LocalOpOkInitResponseSchema>;

/**
 * Request body shared by `POST /api/local-op/auth/{login,status,repos,signout}`.
 *
 * `host` is optional — defaults to `github.com` server-side. Empty / non-string
 * `host` falls back to the default (history of permissive coercion preserved
 * via `.optional()`).
 */
export const LocalOpAuthHostRequestSchema = z
  .object({
    host: z.string().min(1).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpAuthHostRequest = z.infer<typeof LocalOpAuthHostRequestSchema>;

/**
 * Request body for `POST /api/local-op/embeddings/set-key`. `key` REQUIRED
 * non-empty — the embeddings provider API key. Travels renderer → loopback POST
 * body → the 0600 `~/.ok/secrets.yml` file; NEVER logged, spanned, or echoed
 * back. Loopback + Origin gated like the other local-op handlers.
 */
export const LocalOpEmbeddingsSetKeyRequestSchema = z
  .object({
    key: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpEmbeddingsSetKeyRequest = z.infer<typeof LocalOpEmbeddingsSetKeyRequestSchema>;

/**
 * Success body for the embeddings set/clear handlers. `keyPresent` reflects the
 * post-mutation state (true after set, false after clear) so the UI can update
 * without a second round-trip. Never carries the key.
 */
export const LocalOpEmbeddingsMutationSuccessSchema = z
  .object({
    keyPresent: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpEmbeddingsMutationSuccess = z.infer<
  typeof LocalOpEmbeddingsMutationSuccessSchema
>;

/**
 * Request body for `POST /api/local-op/auth/set-identity`. `name` and `email`
 * REQUIRED non-empty (after `.trim()` — empty-after-trim values fail schema
 * via `.refine`). The handler writes these to repo-local git config.
 */
export const LocalOpAuthSetIdentityRequestSchema = z
  .object({
    name: z.string().refine((s) => s.trim().length > 0, { message: 'name must be non-empty' }),
    email: z.string().refine((s) => s.trim().length > 0, { message: 'email must be non-empty' }),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpAuthSetIdentityRequest = z.infer<typeof LocalOpAuthSetIdentityRequestSchema>;

/**
 * Success body for `POST /api/local-op/auth/status`. `authenticated` is the
 * load-bearing field; the CLI may emit additional fields (`login`,
 * `host`, …) which `.loose()` preserves. The handler returns the CLI's last
 * JSON line directly — schema is permissive to accommodate evolving CLI
 * output without lockstep migration.
 */
export const LocalOpAuthStatusSuccessSchema = z
  .object({
    authenticated: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpAuthStatusSuccess = z.infer<typeof LocalOpAuthStatusSuccessSchema>;

/**
 * Success body for `POST /api/local-op/auth/signout` and
 * `POST /api/local-op/auth/set-identity`. Empty object — clients only branch
 * on HTTP status (200 = success). `.loose()` for forward-compat (e.g., a
 * future `signedOutAt: ISO` echo).
 */
export const LocalOpAuthEmptySuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type LocalOpAuthEmptySuccess = z.infer<typeof LocalOpAuthEmptySuccessSchema>;
