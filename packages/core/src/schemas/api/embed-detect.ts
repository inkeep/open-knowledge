/**
 * Cluster K: embed-detection instrumentation.
 *
 * `handleEmbedDetect` (`GET /api/__embed-detect`) is the operator-only
 * diagnostic endpoint for the Cursor / Codex / Claude Code embedded-viewer
 * detection spikes. Returns recent per-request observations from the
 * server-side ring buffer plus an EAGER per-app classification of the
 * most-recent entry — if any one globally-unique signal indicates
 * Cursor / Codex / Claude, the verdict eagerly returns that app.
 *
 * Loopback + Host-header gated — same guard as `handlePrincipal` and
 * `handleMetricsAgentPresence`. Disclosed fields (headers, remote
 * address) are local-editing-only signals; cross-origin / DNS-rebinding
 * attempts are refused.
 *
 * Double-underscore prefix marks the endpoint as diagnostic / internal.
 *
 * Detector design (eager OR-of-globally-unique per the 2026-05-21
 * signal-discovery arc, `spikes-2026-05-21/signal-discovery-synthesis/REPORT.md`):
 *   - Discipline: ONLY signals empirically observed firing from one of
 *     the three target embedded webviewers. Speculative signals
 *     (Anthropic-dormant `cowork-*` schemes; `claude.ai` host that
 *     doesn't currently embed OK; `Electron/` UA token that catches
 *     arbitrary Electron apps; `Sec-CH-UA`-lacks-`Google Chrome` that
 *     also flags Brave/Edge/Vivaldi) are NOT in the detector.
 *   - Each per-app signal IS itself a globally-unique marker (UA
 *     substring per app, Cursor's `?strategy=C_iframe` literal in
 *     referer).
 *   - If ANY one fires → eagerly classify as that app. No AND-of-ANDs.
 *   - Cursor → Codex → Claude precedence resolves the (rare) adversarial
 *     case of multiple per-app markers firing.
 *   - When nothing fires, `app: null`. The endpoint answers "is this
 *     specifically Cursor / Codex / Claude?", not "is this any Electron
 *     host?".
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

/**
 * One entry on `EmbedDetectSuccessSchema.entries`. Mirrors the
 * server-side `EmbedProbeEntry` type — all header fields are optional
 * strings since browsers / non-browser clients vary in which headers
 * they send.
 */
export const EmbedProbeEntrySchema = z
  .object({
    ts: z.number().int().min(0),
    url: z.string(),
    method: z.string(),
    ua: z.string().optional(),
    origin: z.string().optional(),
    referer: z.string().optional(),
    host: z.string().optional(),
    remote: z.string().optional(),
    secChUa: z.string().optional(),
    secChUaMobile: z.string().optional(),
    secChUaPlatform: z.string().optional(),
    secFetchSite: z.string().optional(),
    secFetchDest: z.string().optional(),
    secFetchMode: z.string().optional(),
    secFetchUser: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type EmbedProbeEntryWire = z.infer<typeof EmbedProbeEntrySchema>;

/**
 * Detection verdict derived from the most-recent entry. Eager per-app
 * classification: any one globally-unique signal firing for an app
 * returns that app.
 *
 * `app: null` when no signal fires (no traffic, request is from
 * something other than the three known embedded webviewers, or the
 * buffer is empty). Consumers wanting "is this one of the known
 * embedded webviewers?" check `app !== null`. `signals_fired`
 * enumerates the named signals that fired — open-ended for
 * forward-compat as new empirically-validated signals are added.
 */
export const EmbedDetectionSchema = z
  .object({
    app: z.union([z.literal('cursor'), z.literal('codex'), z.literal('claude'), z.null()]),
    signals_fired: z.array(z.string()),
  })
  .loose() satisfies StandardSchemaV1;
export type EmbedDetection = z.infer<typeof EmbedDetectionSchema>;

/**
 * Success response for `GET /api/__embed-detect`. `entries` is the
 * ring-buffer snapshot ordered newest-first; `count` is its length;
 * `detection` is the eager per-app classification of the newest entry
 * (`app: null`, `signals_fired: []` when the buffer is empty or no
 * signal fires).
 */
export const EmbedDetectSuccessSchema = z
  .object({
    entries: z.array(EmbedProbeEntrySchema),
    count: z.number().int().min(0),
    detection: EmbedDetectionSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type EmbedDetectSuccess = z.infer<typeof EmbedDetectSuccessSchema>;
