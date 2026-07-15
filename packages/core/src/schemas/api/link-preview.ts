/**
 * Wire shape for the external link-preview card. Produced server-side by the
 * SSRF-guarded fetch + bounded head-scan parse, served by `POST /api/link-preview`,
 * and rendered by the editor hover panel. Lives in `packages/core` so producer
 * and consumer bind to one shape.
 *
 * Every field except `domain` is optional: a site that exposes no OG/`<title>`
 * tags still yields `{ domain }`, and the card renders whatever is present. The
 * registrable domain is always derived from the request URL (never from fetched
 * metadata) so a page cannot claim to be a site it is not. `faviconDataUri`, when
 * present, is a self-contained `data:image/…` URI the server built from validated
 * bytes — the card never hotlinks a remote image.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const LinkPreviewMetadataSchema = z
  .object({
    domain: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    siteName: z.string().optional(),
    faviconDataUri: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LinkPreviewMetadata = z.infer<typeof LinkPreviewMetadataSchema>;

/**
 * Request body for `POST /api/link-preview`: the hovered URL to preview. Only
 * "is a string" is asserted here — every scheme/host/redirect check lives in
 * the SSRF-guarded fetch downstream, which treats the value as hostile. An
 * empty or malformed URL flows through to a `{ ok: false }` outcome (the guard
 * rejects it) rather than being special-cased at the schema boundary.
 */
export const LinkPreviewRequestSchema = z
  .object({ url: z.string() })
  .loose() satisfies StandardSchemaV1;
export type LinkPreviewRequest = z.infer<typeof LinkPreviewRequestSchema>;

/**
 * Response envelope for `POST /api/link-preview`. A well-formed, authorized
 * request always returns HTTP 200 with this discriminated outcome: `ok: true`
 * with the assembled card metadata, or `ok: false` with a bounded reason code
 * the renderer treats as "fall back to the URL pill". On the wire the reason is
 * deliberately coarse — `'disabled'` when the egress opt-in is off, `'blocked'`
 * for every guard/fetch rejection — so the body cannot become an
 * internal-network-topology oracle; the granular taxonomy stays in server logs
 * and the local cache. Anti-proxy and body-shape rejections are separate
 * RFC 9457 problem responses, not this envelope.
 *
 * Union members are `.loose()` per the `share.ts` forward-compat convention: a
 * future additive field must not be stripped or rejected by an older client.
 */
export const LinkPreviewResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), metadata: LinkPreviewMetadataSchema }).loose(),
  z.object({ ok: z.literal(false), reason: z.string() }).loose(),
]) satisfies StandardSchemaV1;
export type LinkPreviewResponse = z.infer<typeof LinkPreviewResponseSchema>;
