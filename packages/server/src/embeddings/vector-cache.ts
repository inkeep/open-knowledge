
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  tracedMkdir,
  tracedRename,
  tracedRmSync,
  tracedUnlinkSync,
  tracedWriteFile,
} from '../fs-traced.ts';
import { getLogger } from '../logger.ts';

const log = getLogger('embeddings');

const MANIFEST_SCHEMA_VERSION = 1;
const VEC_SUBDIR = 'vec';
const MANIFEST_NAME = 'manifest.json';

interface ManifestEntry {
  contentHash: string;
  mtimeMs: number;
}

interface ManifestFile {
  schemaVersion: number;
  providerId: string;
  modelId: string;
  dims: number;
  chunkConfigId: string;
  entries: Record<string, ManifestEntry>;
}

interface VectorCacheOptions {
  cacheDir: string | null;
  providerId: string;
  modelId: string;
  dims: number;
  chunkConfigId: string;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function serializeVectors(vectors: readonly Float32Array[]): Uint8Array {
  let total = 0;
  for (const v of vectors) total += v.length;
  const packed = new Float32Array(total);
  let offset = 0;
  for (const v of vectors) {
    packed.set(v, offset);
    offset += v.length;
  }
  return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
}

function deserializeVectors(bytes: Buffer, dims: number): Float32Array[] {
  const aligned = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const floats = new Float32Array(aligned);
  if (floats.length % dims !== 0) {
    throw new Error(`vector blob length ${floats.length} is not a multiple of dims ${dims}`);
  }
  const chunks: Float32Array[] = [];
  for (let i = 0; i < floats.length; i += dims) {
    chunks.push(floats.slice(i, i + dims));
  }
  return chunks;
}

export class VectorCache {
  private readonly cacheDir: string | null;
  private readonly vecDir: string | null;
  private readonly manifestPath: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly dims: number;
  readonly chunkConfigId: string;

  private readonly entries = new Map<string, ManifestEntry>();
  private readonly vectorsByHash = new Map<string, Float32Array[]>();
  private readonly persistedHashes = new Set<string>();
  private dirty = false;

  constructor(options: VectorCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.vecDir = options.cacheDir ? join(options.cacheDir, VEC_SUBDIR) : null;
    this.manifestPath = options.cacheDir ? join(options.cacheDir, MANIFEST_NAME) : null;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.dims = options.dims;
    this.chunkConfigId = options.chunkConfigId;
  }

  async init(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.vecDir) return;
    let manifest: ManifestFile | null = null;
    try {
      if (existsSync(this.manifestPath)) {
        manifest = JSON.parse(await readFile(this.manifestPath, 'utf-8')) as ManifestFile;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[embeddings] unreadable cache manifest — rebuilding',
      );
      manifest = null;
    }

    const identityMatches =
      manifest !== null &&
      manifest.schemaVersion === MANIFEST_SCHEMA_VERSION &&
      manifest.providerId === this.providerId &&
      manifest.modelId === this.modelId &&
      manifest.dims === this.dims &&
      manifest.chunkConfigId === this.chunkConfigId;

    if (!identityMatches) {
      if (manifest !== null) {
        log.info(
          { hadModel: manifest.modelId, wantModel: this.modelId },
          '[embeddings] cache identity changed (provider/model/dims/chunking) — invalidating',
        );
      }
      this.wipeDisk();
      return;
    }
    if (!manifest) return; // unreachable once identity matched; narrows for TS

    for (const [docId, entry] of Object.entries(manifest.entries)) {
      if (!entry?.contentHash) continue;
      this.entries.set(docId, { contentHash: entry.contentHash, mtimeMs: entry.mtimeMs ?? 0 });
      if (!this.vectorsByHash.has(entry.contentHash)) {
        try {
          const blobPath = join(this.vecDir, `${entry.contentHash}.bin`);
          if (existsSync(blobPath)) {
            const bytes = await readFile(blobPath);
            this.vectorsByHash.set(entry.contentHash, deserializeVectors(bytes, this.dims));
            this.persistedHashes.add(entry.contentHash);
          }
        } catch (err) {
          log.warn(
            { hash: entry.contentHash, err: err instanceof Error ? err.message : String(err) },
            '[embeddings] corrupt vector blob — will re-embed',
          );
        }
      }
    }
  }

  isFresh(docId: string, mtimeMs: number): boolean {
    const entry = this.entries.get(docId);
    return (
      entry !== undefined && entry.mtimeMs === mtimeMs && this.vectorsByHash.has(entry.contentHash)
    );
  }

  link(docId: string, contentHash: string, mtimeMs: number): boolean {
    if (!this.vectorsByHash.has(contentHash)) return false;
    const prev = this.entries.get(docId);
    if (!prev || prev.contentHash !== contentHash || prev.mtimeMs !== mtimeMs) this.dirty = true;
    this.entries.set(docId, { contentHash, mtimeMs });
    return true;
  }

  store(docId: string, contentHash: string, mtimeMs: number, vectors: Float32Array[]): void {
    this.vectorsByHash.set(contentHash, vectors);
    this.entries.set(docId, { contentHash, mtimeMs });
    this.dirty = true;
  }

  getVectors(docId: string): Float32Array[] | undefined {
    const entry = this.entries.get(docId);
    if (!entry) return undefined;
    return this.vectorsByHash.get(entry.contentHash);
  }

  get embeddedCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      const v = this.vectorsByHash.get(entry.contentHash);
      if (v && v.length > 0) n += 1;
    }
    return n;
  }

  retain(activeDocIds: ReadonlySet<string>): void {
    for (const docId of this.entries.keys()) {
      if (!activeDocIds.has(docId)) {
        this.entries.delete(docId);
        this.dirty = true;
      }
    }
    const referenced = new Set<string>();
    for (const entry of this.entries.values()) referenced.add(entry.contentHash);
    for (const hash of this.vectorsByHash.keys()) {
      if (!referenced.has(hash)) this.vectorsByHash.delete(hash);
    }
  }

  clearMemory(): void {
    this.entries.clear();
    this.vectorsByHash.clear();
    this.persistedHashes.clear();
    this.dirty = false;
  }

  async persist(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.vecDir) return;
    if (!this.dirty) return; // nothing changed since last persist — skip the write
    try {
      await tracedMkdir(this.vecDir, { recursive: true });
      const referenced = new Set<string>();
      for (const entry of this.entries.values()) referenced.add(entry.contentHash);

      for (const hash of referenced) {
        if (this.persistedHashes.has(hash)) continue;
        const vectors = this.vectorsByHash.get(hash);
        if (!vectors) continue;
        await tracedWriteFile(join(this.vecDir, `${hash}.bin`), serializeVectors(vectors));
        this.persistedHashes.add(hash);
      }

      const manifest: ManifestFile = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        providerId: this.providerId,
        modelId: this.modelId,
        dims: this.dims,
        chunkConfigId: this.chunkConfigId,
        entries: Object.fromEntries(this.entries),
      };
      const tmp = `${this.manifestPath}.tmp`;
      await tracedWriteFile(tmp, JSON.stringify(manifest));
      await tracedRename(tmp, this.manifestPath);

      for (const file of readdirSync(this.vecDir)) {
        if (!file.endsWith('.bin')) continue;
        const hash = file.slice(0, -'.bin'.length);
        if (!referenced.has(hash)) {
          tracedUnlinkSync(join(this.vecDir, file));
          this.persistedHashes.delete(hash);
        }
      }
      this.dirty = false;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[embeddings] failed to persist vector cache',
      );
    }
  }

  private wipeDisk(): void {
    if (!this.cacheDir) return;
    try {
      tracedRmSync(this.cacheDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[embeddings] failed to wipe stale cache',
      );
    }
  }
}
