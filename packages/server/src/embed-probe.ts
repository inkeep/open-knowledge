/**
 * In-process ring buffer for per-request client-context observations.
 *
 * Powers the `/api/__embed-detect` diagnostic endpoint used by the
 * Cursor / Codex / Claude Code embedded-viewer detection spikes — the
 * detection signal is overwhelmingly carried in `User-Agent` plus a few
 * standard request headers, and the spikes need a deterministic surface
 * to read recent traffic from.
 *
 * The existing OTel span at api-extension.ts already records
 * `user_agent.original`, but OTel is opt-in (`OTEL_SDK_DISABLED=false`
 * required) and defaults OFF, so the UA capture is functionally
 * discarded at runtime. This ring buffer is the always-on path.
 *
 * SECURITY: callers MUST gate the consumer endpoint behind the same
 * loopback + Host-header guard the other operator-only routes use
 * (`handlePrincipal`, `handleMetricsAgentPresence`). The buffer is
 * populated unconditionally from `onRequest`, so the gate has to live
 * on the read side — readers see only loopback traffic in practice,
 * but a misconfigured `--host 0.0.0.0` deployment would route LAN
 * peers through here too.
 */

import { UA_PATTERNS } from '@inkeep/open-knowledge-core';

/**
 * One captured request observation. All header fields are best-effort
 * strings — Node's `IncomingMessage.headers` types them as
 * `string | string[] | undefined`, and we narrow at the call site.
 */
export type EmbedProbeEntry = {
  ts: number;
  url: string;
  method: string;
  ua?: string;
  origin?: string;
  referer?: string;
  host?: string;
  remote?: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  secFetchSite?: string;
  secFetchDest?: string;
  secFetchMode?: string;
  secFetchUser?: string;
};

/**
 * Bounded FIFO buffer with newest-first read semantics. `push` is O(1)
 * via a circular array; `read` is O(n) and materializes a snapshot.
 *
 * Why newest-first read: the consumer is a diagnostic endpoint where
 * "what was the latest request?" is the dominant query. Returning a
 * fresh array per `read()` (rather than a live view) keeps the buffer
 * safe to mutate concurrently with downstream consumers iterating the
 * snapshot.
 */
export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly store: (T | undefined)[];
  private writeIndex = 0;
  private filled = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.store = new Array<T | undefined>(capacity);
  }

  push(entry: T): void {
    this.store[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.writeIndex === 0) this.filled = true;
  }

  /**
   * Snapshot of buffer contents, newest first. Returns at most
   * `capacity` items; the oldest items are dropped once the buffer
   * wraps.
   */
  read(): T[] {
    const out: T[] = [];
    const length = this.filled ? this.capacity : this.writeIndex;
    // Walk backwards from the most recent write (writeIndex - 1).
    for (let offset = 1; offset <= length; offset++) {
      const index = (this.writeIndex - offset + this.capacity) % this.capacity;
      const value = this.store[index];
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  get size(): number {
    return this.filled ? this.capacity : this.writeIndex;
  }
}

/**
 * Module-scope singleton — one buffer per process. Capacity 256 covers
 * the ~30s of activity the spike scripts inspect after an embed
 * navigation without growing the process RSS meaningfully (each entry
 * is ~1 KB of strings worst-case).
 */
export const EMBED_PROBE_CAPACITY = 256;
export const embedProbeRing = new RingBuffer<EmbedProbeEntry>(EMBED_PROBE_CAPACITY);

/**
 * Push a single observation into the singleton buffer. Header values
 * are narrowed from `string | string[] | undefined` to `string |
 * undefined` at the call site — multi-valued headers (rare in
 * practice) collapse to their joined string form by Node's parser
 * before we see them for the ones we capture.
 */
export function recordEmbedProbe(entry: EmbedProbeEntry): void {
  embedProbeRing.push(entry);
}

// ---------------------------------------------------------------------------
// Per-app globally-unique signal definitions
//
// Discipline: ONLY signals empirically observed firing from one of the
// three target embedded webviewers (Cursor / Codex / Claude). Each
// signal listed below is unique to its named app — no other vendor's
// requests carry the same marker. Speculative signals (Anthropic-
// dormant `cowork-*` schemes; `claude.ai` host that doesn't currently
// embed OK; `Electron/` UA token that catches arbitrary Electron apps;
// `Sec-CH-UA`-lacks-`Google Chrome` that also flags Brave/Edge/Vivaldi)
// are NOT in the detector. Forward-compat signals can be added when
// they're empirically validated.
//
// Optional `(flavor)` parenthetical in the UA regexes handles
// Dev/Beta/Canary builds (Codex Desktop Dev emits
// `Codex(Dev)/26.513.31313`).
// ---------------------------------------------------------------------------

// Per-app UA regexes come from the SINGLE definition in core
// (`UA_PATTERNS` in `@inkeep/open-knowledge-core`) that the client-side
// `detectEmbeddedHostFromBrowser` also consumes — so the two detectors
// cannot drift on what a Cursor / Codex / Claude UA looks like. The
// `(?:\([^)]+\))?` parenthetical absorbs Dev/Beta/Canary flavor builds
// (`Codex(Dev)/26.513.31313`). Core keys the Claude family as
// `claude-desktop` (app-granular product surface); this diagnostic wire
// surface emits `claude` — the two vocabularies are intentional.
const CURSOR_UA_RE = UA_PATTERNS.cursor;
const CODEX_UA_RE = UA_PATTERNS.codex;
// Claude embed-context is not realized today (Claude.app has no
// arbitrary-URL embed surface reaching OK); the regex is validated and
// fires correctly when/if Claude integration unblocks.
const CLAUDE_UA_RE = UA_PATTERNS['claude-desktop'];

// Cursor's integrated browser pane wraps the embed in an `<iframe>`
// with `?strategy=C_iframe` appended to the OK SPA URL — Cursor-
// specific architectural literal, no other vendor uses this token.
const CURSOR_REFERER_STRATEGY_LITERAL = '?strategy=C_iframe';

// ---------------------------------------------------------------------------
// Detection verdict — eager OR-of-globally-unique.
//
// Wire shape exported from `@inkeep/open-knowledge-core` as
// `EmbedDetection` (z.infer of the schema); this local alias stays
// in-file for the handler to consume without a circular import.
// ---------------------------------------------------------------------------

type DetectedApp = 'cursor' | 'codex' | 'claude' | null;

type EmbedDetection = {
  app: DetectedApp;
  signals_fired: string[];
};

const EMPTY_DETECTION: EmbedDetection = {
  app: null,
  signals_fired: [],
};

/**
 * Eagerly classify the newest entry's host app. Returns the FIRST
 * per-app match (Cursor → Codex → Claude precedence) when any one
 * globally-unique signal fires, else `app: null`.
 *
 * Why eager OR-of-globally-unique rather than AND-of-ANDs: each
 * per-app signal IS itself globally-unique (UA substring, Cursor's
 * `?strategy=C_iframe` referer literal). Requiring multiple to AND
 * together adds no discrimination — it only adds false-NEGATIVE risk
 * (one signal absent → whole verdict drops). In practice, only one
 * app's per-app signals fire per request.
 *
 * Precedence (Cursor → Codex → Claude) handles the rare adversarial
 * UA-spoof case where multiple per-app markers somehow fire.
 *
 * No `electron-other` fallback. The endpoint answers "is this
 * specifically Cursor / Codex / Claude?" — not "is this in some
 * generic Electron host?". An `Electron/` UA token or
 * `Sec-CH-UA`-lacks-`Google Chrome` shape catches Brave/Edge/Vivaldi
 * and arbitrary Electron apps too, which aren't what we're detecting.
 *
 * `entry === undefined` → returns `EMPTY_DETECTION` (no traffic, or
 * adversarial empty-buffer probe). Consumers don't need to special-
 * case empty. `app !== null` answers "is this one of the three known
 * embedded webviewers?".
 */
export function deriveDetection(entry: EmbedProbeEntry | undefined): EmbedDetection {
  if (!entry) return { ...EMPTY_DETECTION };

  const fired: string[] = [];
  const ua = entry.ua;
  const referer = entry.referer;

  // ---- Cursor ----
  const cursorUaFires = !!ua && CURSOR_UA_RE.test(ua);
  const cursorRefererFires = !!referer && referer.includes(CURSOR_REFERER_STRATEGY_LITERAL);
  if (cursorUaFires) fired.push('cursor_ua_regex');
  if (cursorRefererFires) fired.push('cursor_referer_strategy_iframe');
  if (cursorUaFires || cursorRefererFires) {
    return { app: 'cursor', signals_fired: fired };
  }

  // ---- Codex ----
  const codexUaFires = !!ua && CODEX_UA_RE.test(ua);
  if (codexUaFires) fired.push('codex_ua_regex');
  if (codexUaFires) {
    return { app: 'codex', signals_fired: fired };
  }

  // ---- Claude ----
  const claudeUaFires = !!ua && CLAUDE_UA_RE.test(ua);
  if (claudeUaFires) fired.push('claude_ua_regex');
  if (claudeUaFires) {
    return { app: 'claude', signals_fired: fired };
  }

  return { ...EMPTY_DETECTION };
}
