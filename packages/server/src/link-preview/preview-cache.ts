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

const MANIFEST_SCHEMA_VERSION = 1;
const META_SUBDIR = 'meta';
const MANIFEST_NAME = 'manifest.json';

const DEFAULT_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

export type LinkPreviewOutcome =
  | { ok: true; metadata: LinkPreviewMetadata }
  | { ok: false; reason: string };

interface CacheEntry {
  status: 'ok' | 'negative';
  fetchedAt: number;
  expiresAt: number;
  reason?: string;
}

interface ManifestFile {
  schemaVersion: number;
  entries: Record<string, CacheEntry>;
}

export interface LinkPreviewCacheOptions {
  cacheDir: string | null;
  maxEntries?: number;
  successTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

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

  private readonly entries = new Map<string, CacheEntry>();
  private readonly payloads = new Map<string, LinkPreviewMetadata>();
  private readonly persistedKeys = new Set<string>();
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

  async init(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.metaDir) return;
    let manifest: ManifestFile | null = null;
    try {
      if (existsSync(this.manifestPath)) {
        manifest = JSON.parse(await readFile(this.manifestPath, 'utf-8')) as ManifestFile;
      }
    } catch (err) {
      log.warn({ err }, '[link-preview] unreadable cache manifest — starting empty');
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
        if (!payload) continue;
        this.payloads.set(key, payload);
        this.persistedKeys.add(key);
      }
      this.entries.set(key, entry);
    }
  }

  async load(
    rawUrl: string,
    compute: () => Promise<LinkPreviewOutcome>,
  ): Promise<LinkPreviewOutcome> {
    const key = normalizePreviewUrl(rawUrl);
    if (key === null) return compute();

    const fresh = this.getFresh(key);
    if (fresh) return fresh;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const outcome = await compute();
      this.record(key, outcome);
      return outcome;
    })();
    const tracked = promise.finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  private getFresh(key: string): LinkPreviewOutcome | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.drop(key);
      this.dirty = true;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.status === 'negative') {
      return { ok: false, reason: entry.reason ?? 'error' };
    }
    const metadata = this.payloads.get(key);
    if (!metadata) {
      this.drop(key);
      this.dirty = true;
      return undefined;
    }
    return { ok: true, metadata };
  }

  private record(key: string, outcome: LinkPreviewOutcome): void {
    const fetchedAt = this.now();
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
      log.warn({ err }, '[link-preview] failed to persist cache');
    }
  }

  clearMemory(): void {
    this.entries.clear();
    this.payloads.clear();
    this.persistedKeys.clear();
    this.inFlight.clear();
    this.dirty = false;
  }

  async wipe(): Promise<void> {
    this.clearMemory();
    if (!this.cacheDir) return;
    try {
      tracedRmSync(this.cacheDir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ err }, '[link-preview] failed to wipe cache');
    }
  }

  get size(): number {
    return this.entries.size;
  }

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
      log.warn({ err }, '[link-preview] unreadable cache blob — treating as miss');
      return null;
    }
  }
}
