/**
 * Per-file lint-result cache for the project audit walk. The walk is serial and
 * CPU-bound in the lint engines (milliseconds per doc), so on a large KB a
 * whole-project audit costs tens of seconds — and the freshness triggers behind
 * file-tree tints re-run it far more often than the manual audit button ever
 * did.
 *
 * A cached entry is keyed on everything a doc's diagnostics derive from: its
 * identity, its disk stamp, and a fingerprint of the fully-resolved config it
 * was linted with (base + native `.markdownlint.*` cascade + frontmatter
 * schemas). So an audit at unchanged config over unchanged files does no lint
 * work at all — which is what the refresh button, the post-`Fix all` re-audit,
 * and per-doc revalidation all are.
 *
 * What it deliberately does NOT accelerate: a rule toggle. Changing the
 * effective config changes the fingerprint for every doc, so a genuine toggle
 * is a full re-walk by construction. Making THAT cheap needs either a
 * worker-thread fan-out or an all-rules superset filtered per active rule set;
 * both are larger changes than this cache.
 *
 * Docs read from a live CRDT overlay are never cached — their bytes move
 * without touching the disk stamp the key rests on.
 */

import { createHash } from 'node:crypto';
import type { LintDiagnostic, LinterConfig } from '@inkeep/open-knowledge-core';

/**
 * Entry ceiling. A config change mints new keys for the docs it governs without
 * dropping the ones they replace, so the live set is one generation per project
 * plus however many superseded generations have not yet aged out through LRU —
 * this is a leak bound, not a working-set target. Nothing purges a generation
 * eagerly on purpose: native `.markdownlint.*` files cascade, so a config write
 * invalidates only the subtree it governs and a blanket clear would discard
 * still-valid entries for every unaffected doc.
 */
const MAX_ENTRIES = 10_000;

/**
 * Byte ceiling over the serialized payloads. Entry count alone is a poor memory
 * bound: a KB where every doc carries dozens of findings holds far more per
 * entry than one that is nearly clean.
 */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Entries hold each doc's diagnostics SERIALIZED, not as live objects. A
 * 6k-doc KB produces ~150k diagnostics, and retaining those as ~750k nested
 * objects across a walk costs more in GC scanning than the lint work it saves
 * — measured at 2.6x the uncached audit. One flat string per doc is a single
 * allocation the collector never has to trace into, which turns the retention
 * cost back into noise; the price is a parse on hit, far below a re-lint.
 */
interface CacheEntry {
  json: string;
  /**
   * UTF-8 byte length of `json`, computed once at insert. Accounting on this
   * rather than `json.length` (UTF-16 code units) keeps `MAX_BYTES` a true byte
   * ceiling over the serialized payloads for non-Latin diagnostic text.
   */
  bytes: number;
}

export interface AuditCacheStats {
  hits: number;
  misses: number;
  entries: number;
  bytes: number;
}

export interface AuditCacheLimits {
  maxEntries?: number;
  maxBytes?: number;
}

/**
 * Insertion-ordered so eviction is least-recently-used: a hit re-inserts its
 * key at the back (`Map` iteration order is insertion order, and `delete` +
 * `set` is the idiomatic JS promotion).
 */
export class AuditCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private byteCount = 0;
  private hits = 0;
  private misses = 0;

  constructor(limits: AuditCacheLimits = {}) {
    this.maxEntries = limits.maxEntries ?? MAX_ENTRIES;
    this.maxBytes = limits.maxBytes ?? MAX_BYTES;
  }

  /**
   * Fingerprint a resolved config. Hashes the config itself rather than the
   * inputs that produced it, so no assumption is needed about which inputs
   * reach diagnostics — base rules, a governing native file's rules, and
   * loaded frontmatter schema bodies are all serializable and all included.
   */
  static fingerprintConfig(config: LinterConfig): string {
    return createHash('sha1').update(JSON.stringify(config)).digest('base64');
  }

  /**
   * `mtimeMs` + `size` is the standard content stamp. It can theoretically miss
   * a same-millisecond, same-length rewrite; every write path that matters here
   * either goes through the live-CRDT overlay (never cached) or lands a
   * different length or timestamp.
   */
  static key(parts: {
    contentDir: string;
    docRelPath: string;
    mtimeMs: number;
    size: number;
    configFingerprint: string;
  }): string {
    // contentDir is part of the key so one process serving several projects —
    // or a test run booting many servers over identically-named fixture docs —
    // cannot collide.
    return [
      parts.contentDir,
      parts.docRelPath,
      parts.mtimeMs,
      parts.size,
      parts.configFingerprint,
      // NUL separator, written as an escape so this source stays plain text: a raw
      // NUL byte makes git classify the file as binary and hide its diffs. Paths and
      // base64 fingerprints can contain spaces and slashes but never NUL, so this is
      // the one separator that cannot let two different tuples build the same key.
    ].join('\u0000');
  }

  /**
   * Cached diagnostics for `key`, or null. Deserialized fresh each time, so a
   * caller that sorts or splices what it receives cannot corrupt the entry.
   * The payload is this cache's own `JSON.stringify` output, so the parse is
   * total — no failure branch to handle.
   */
  get(key: string): LintDiagnostic[] | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return JSON.parse(entry.json) as LintDiagnostic[];
  }

  set(key: string, diagnostics: readonly LintDiagnostic[]): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.byteCount -= existing.bytes;
      this.entries.delete(key);
    }
    const json = JSON.stringify(diagnostics);
    const bytes = Buffer.byteLength(json, 'utf8');
    this.entries.set(key, { json, bytes });
    this.byteCount += bytes;
    this.evictToBounds();
  }

  private evictToBounds(): void {
    while (
      (this.entries.size > this.maxEntries || this.byteCount > this.maxBytes) &&
      this.entries.size > 1
    ) {
      // `keys().next()` is the least-recently-used key (insertion order).
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted !== undefined) this.byteCount -= evicted.bytes;
    }
  }

  stats(): AuditCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      bytes: this.byteCount,
    };
  }

  clear(): void {
    this.entries.clear();
    this.byteCount = 0;
    this.hits = 0;
    this.misses = 0;
  }
}
