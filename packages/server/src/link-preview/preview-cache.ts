/**
 * Persistent, best-effort cache for external link previews.
 *
 * Lives under `<projectDir>/.ok/local/link-previews/` (git-ignored, never synced).
 * A hover fetch is comparatively expensive (SSRF-guarded network round-trip +
 * HTML parse + favicon fetch), so a repeated hover of the same link — and a
 * document's second open — should serve from disk with no network at all.
 *
 * Layout mirrors the vector cache (manifest index + payload blobs):
 *   link-previews/
 *     manifest.json          { schemaVersion, entries: { <normalizedUrl>: entry } }
 *     meta/<sha256(url)>.json the LinkPreviewMetadata for a success entry
 *
 * The manifest holds only the small index (status + timestamps); the potentially
 * large success payload — its favicon `data:` URI can approach the fetch cap —
 * lives in a per-URL blob, so a hot LRU-touch never rewrites favicon bytes.
 *
 * The key is the normalized URL (scheme+host+path+query, fragment and userinfo
 * stripped), so `#a` / `#b` variants and credentialed forms of one page share
 * one entry.
 *
 * Recency is Map insertion order: a hit deletes-and-reinserts the key so the
 * oldest key is always `entries.keys().next()`, and eviction past the size cap
 * drops from the front. Success entries live ~7 days, failures ~1 hour (so a
 * dead link is not re-hammered); an expired entry reads as a miss and is dropped.
 *
 * Every disk operation is wrapped in try/catch and degrades to a recompute — a
 * corrupt manifest or blob is a miss, never a throw into the caller. Reads come
 * back through the metadata schema, so a tampered blob that no longer matches the
 * shape is dropped rather than trusted. Concurrent identical lookups coalesce to
 * a single in-flight compute.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type LinkPreviewMetadata, LinkPreviewMetadataSchema } from '@inkeep/open-knowledge-core';
import {
  tracedMkdir,
  tracedRename,
  tracedRmSync,
  tracedUnlinkSync,
  tracedWriteFile,
} from '../fs-traced.ts';
import { getLogger } from '../logger.ts';

const log = getLogger('link-preview.cache');

/** On-disk manifest layout version — bump on any structural format change. */
const MANIFEST_SCHEMA_VERSION = 1;
const META_SUBDIR = 'meta';
const MANIFEST_NAME = 'manifest.json';

/** A cached success serves this long before it is re-fetched. */
const DEFAULT_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A cached failure serves this long — short, so a transiently-dead link recovers. */
const DEFAULT_NEGATIVE_TTL_MS = 60 * 60 * 1000;
/** Entries retained before the least-recently-used is evicted. */
const DEFAULT_MAX_ENTRIES = 256;

/**
 * The result of a preview lookup: the assembled card metadata, or a bounded
 * reason code for a failure. This is exactly the envelope the route returns and
 * the value the cache persists.
 */
export type LinkPreviewOutcome =
  | { ok: true; metadata: LinkPreviewMetadata }
  | { ok: false; reason: string };

interface CacheEntry {
  status: 'ok' | 'negative';
  fetchedAt: number;
  expiresAt: number;
  /** Present only on a negative entry. */
  reason?: string;
}

interface ManifestFile {
  schemaVersion: number;
  entries: Record<string, CacheEntry>;
}

export interface LinkPreviewCacheOptions {
  /** Cache home (`<projectDir>/.ok/local/link-previews`), or `null` for memory-only (tests). */
  cacheDir: string | null;
  /** Overrides {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Overrides {@link DEFAULT_SUCCESS_TTL_MS}. */
  successTtlMs?: number;
  /** Overrides {@link DEFAULT_NEGATIVE_TTL_MS}. */
  negativeTtlMs?: number;
  /** Clock seam; defaults to `Date.now`. Injected so TTL tests need no sleeps. */
  now?: () => number;
}

/**
 * Normalize a URL to its cache key: scheme + host + path + query, with the
 * fragment and any userinfo removed. Returns `null` for an unparseable URL, so
 * a caller declines to cache rather than keying on a malformed string.
 */
export function normalizePreviewUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf-8').digest('hex');
}

export class LinkPreviewCache {
  private readonly cacheDir: string | null;
  private readonly metaDir: string | null;
  private readonly manifestPath: string | null;
  private readonly maxEntries: number;
  private readonly successTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;

  /** normalizedUrl → index entry, in LRU order (oldest first). */
  private readonly entries = new Map<string, CacheEntry>();
  /** normalizedUrl → success payload (mirrors the `ok` entries). */
  private readonly payloads = new Map<string, LinkPreviewMetadata>();
  /** normalizedUrl whose success blob is already on disk (skip re-write on persist). */
  private readonly persistedKeys = new Set<string>();
  /** In-flight computes, keyed by normalizedUrl — the single-flight seam. */
  private readonly inFlight = new Map<string, Promise<LinkPreviewOutcome>>();

  private dirty = false;
  private persisting = false;
  private persistPending = false;

  constructor(options: LinkPreviewCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.metaDir = options.cacheDir ? join(options.cacheDir, META_SUBDIR) : null;
    this.manifestPath = options.cacheDir ? join(options.cacheDir, MANIFEST_NAME) : null;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Load the manifest + referenced success blobs into memory, dropping any
   * entry already past its TTL or whose blob is missing/unreadable. Never throws:
   * an absent, corrupt, or version-mismatched cache starts empty.
   */
  async init(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.metaDir) return;
    let manifest: ManifestFile | null = null;
    try {
      if (existsSync(this.manifestPath)) {
        manifest = JSON.parse(await readFile(this.manifestPath, 'utf-8')) as ManifestFile;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[link-preview] unreadable cache manifest — starting empty',
      );
      return;
    }
    if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || !manifest.entries) {
      return;
    }

    const now = this.now();
    for (const [key, entry] of Object.entries(manifest.entries)) {
      if (!entry || (entry.status !== 'ok' && entry.status !== 'negative')) continue;
      if (typeof entry.expiresAt !== 'number' || now >= entry.expiresAt) continue;
      if (entry.status === 'ok') {
        const payload = await this.readBlob(key);
        if (!payload) continue; // no usable payload → not a serveable success
        this.payloads.set(key, payload);
        this.persistedKeys.add(key);
      }
      this.entries.set(key, entry);
    }
  }

  /**
   * Return the cached outcome for `rawUrl` if fresh, otherwise run `compute`
   * once — coalescing concurrent identical lookups onto a single in-flight
   * promise — and cache its result. A negative cache hit returns the stored
   * failure without recomputing.
   */
  async load(
    rawUrl: string,
    compute: () => Promise<LinkPreviewOutcome>,
  ): Promise<LinkPreviewOutcome> {
    const key = normalizePreviewUrl(rawUrl);
    if (key === null) return compute(); // unkeyable → run once, don't cache

    const fresh = this.getFresh(key);
    if (fresh) return fresh;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const outcome = await compute();
      this.record(key, outcome);
      return outcome;
    })();
    // Detach cleanup from the returned promise so a thrown compute still frees
    // the single-flight slot without turning the rejection into an unhandled one
    // for coalesced awaiters.
    const tracked = promise.finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  /** Fresh (unexpired) cached outcome for a normalized key, bumping its recency. */
  private getFresh(key: string): LinkPreviewOutcome | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.drop(key);
      this.dirty = true;
      return undefined;
    }
    // LRU touch: reinsert at the end so the oldest key stays at the front.
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.status === 'negative') {
      return { ok: false, reason: entry.reason ?? 'error' };
    }
    const metadata = this.payloads.get(key);
    if (!metadata) {
      // A success index with no payload can't be served — treat as a miss.
      this.drop(key);
      this.dirty = true;
      return undefined;
    }
    return { ok: true, metadata };
  }

  private record(key: string, outcome: LinkPreviewOutcome): void {
    const fetchedAt = this.now();
    // A record always follows a miss/expiry, so any prior blob is stale.
    this.persistedKeys.delete(key);
    this.entries.delete(key);
    this.payloads.delete(key);
    if (outcome.ok) {
      this.entries.set(key, { status: 'ok', fetchedAt, expiresAt: fetchedAt + this.successTtlMs });
      this.payloads.set(key, outcome.metadata);
    } else {
      this.entries.set(key, {
        status: 'negative',
        fetchedAt,
        expiresAt: fetchedAt + this.negativeTtlMs,
        reason: outcome.reason,
      });
    }
    this.dirty = true;
    this.evict();
  }

  /** Drop the least-recently-used entries until the cap is satisfied. */
  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
      this.dirty = true;
    }
  }

  private drop(key: string): void {
    this.entries.delete(key);
    this.payloads.delete(key);
    this.persistedKeys.delete(key);
  }

  /**
   * Flush the manifest + any unwritten success blobs to disk and GC orphaned
   * blob files. Best-effort: an unwritable cache logs and returns rather than
   * throwing. Concurrent calls coalesce so two fires can't race one manifest.
   */
  async persist(): Promise<void> {
    if (!this.cacheDir) return;
    if (this.persisting) {
      this.persistPending = true;
      return;
    }
    this.persisting = true;
    try {
      do {
        this.persistPending = false;
        await this.writeToDisk();
      } while (this.persistPending && this.dirty);
    } finally {
      this.persisting = false;
    }
  }

  private async writeToDisk(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.metaDir) return;
    if (!this.dirty) return;
    try {
      await tracedMkdir(this.metaDir, { recursive: true });

      const referencedHashes = new Set<string>();
      for (const [key, entry] of this.entries) {
        if (entry.status !== 'ok') continue;
        referencedHashes.add(hashKey(key));
        if (this.persistedKeys.has(key)) continue;
        const metadata = this.payloads.get(key);
        if (!metadata) continue;
        await tracedWriteFile(join(this.metaDir, `${hashKey(key)}.json`), JSON.stringify(metadata));
        this.persistedKeys.add(key);
      }

      const manifest: ManifestFile = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        entries: Object.fromEntries(this.entries),
      };
      const tmp = `${this.manifestPath}.tmp`;
      await tracedWriteFile(tmp, JSON.stringify(manifest));
      await tracedRename(tmp, this.manifestPath);

      for (const file of readdirSync(this.metaDir)) {
        if (!file.endsWith('.json')) continue;
        const hash = file.slice(0, -'.json'.length);
        if (!referencedHashes.has(hash)) {
          tracedUnlinkSync(join(this.metaDir, file));
        }
      }
      this.dirty = false;
    } catch (err) {
      // Persistence is best-effort: an unwritable cache degrades to a recompute
      // next boot, it must never fail a preview request.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[link-preview] failed to persist cache',
      );
    }
  }

  /** Forget everything in memory; the disk store is untouched. */
  clearMemory(): void {
    this.entries.clear();
    this.payloads.clear();
    this.persistedKeys.clear();
    this.inFlight.clear();
    this.dirty = false;
  }

  /** Wipe memory + the on-disk cache directory (best-effort). */
  async wipe(): Promise<void> {
    this.clearMemory();
    if (!this.cacheDir) return;
    try {
      tracedRmSync(this.cacheDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[link-preview] failed to wipe cache',
      );
    }
  }

  /** Number of live entries (coverage / cap assertions). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Read + validate a success blob. Returns `null` when the blob is absent,
   * unreadable, or no longer matches the metadata shape (a tampered or
   * schema-drifted file is dropped, not trusted).
   */
  private async readBlob(key: string): Promise<LinkPreviewMetadata | null> {
    if (!this.metaDir) return null;
    const blobPath = join(this.metaDir, `${hashKey(key)}.json`);
    try {
      if (!existsSync(blobPath)) return null;
      const parsed = LinkPreviewMetadataSchema.safeParse(
        JSON.parse(await readFile(blobPath, 'utf-8')),
      );
      return parsed.success ? parsed.data : null;
    } catch (err) {
      // Mirror the manifest-level warn: a corrupt/unreadable blob is a miss, not
      // a throw. Reason only — never the URL/host/content (topology-leak hygiene).
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[link-preview] unreadable cache blob — treating as miss',
      );
      return null;
    }
  }
}
