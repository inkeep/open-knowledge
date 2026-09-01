import { createHash } from 'node:crypto';
import type { LintDiagnostic, LinterConfig } from '@inkeep/open-knowledge-core';

const MAX_ENTRIES = 10_000;

const MAX_BYTES = 64 * 1024 * 1024;

interface CacheEntry {
  json: string;
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

  static fingerprintConfig(config: LinterConfig): string {
    return createHash('sha1').update(JSON.stringify(config)).digest('base64');
  }

  static key(parts: {
    contentDir: string;
    docRelPath: string;
    mtimeMs: number;
    size: number;
    configFingerprint: string;
  }): string {
    return [
      parts.contentDir,
      parts.docRelPath,
      parts.mtimeMs,
      parts.size,
      parts.configFingerprint,
    ].join('\u0000');
  }

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
