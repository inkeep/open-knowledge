/**
 * Persistent, incremental, content-addressed vector cache.
 *
 * Lives under `<projectDir>/.ok/local/embeddings/` (git-ignored, never synced —
 * NOT a per-doc sidecar in user content). The
 * Orama corpus is rebuilt from scratch on every change, so embeddings — which
 * are 100× more expensive to compute than the index — need their own durable
 * store that survives corpus rebuilds.
 *
 * Layout (plain `fs`, NOT sqlite — must run under both Bun and Electron real-Node,
 * and `bun:sqlite` is Bun-only):
 *   embeddings/
 *     manifest.json            { schemaVersion, providerId, modelId, dims, identityDims, chunkConfigId, entries }
 *     vec/<contentHash>.bin    Float32 blob, length = chunkCount * dims
 *
 * Content-addressed: a blob is named by the SHA-256 of the document content, so
 * two docs with identical content share one blob and a doc reverting to old
 * content re-hits its old vectors for free. Incremental reconciliation is an
 * mtime pre-filter then a SHA-256 confirm: an unchanged mtime skips hashing
 * entirely; a changed mtime but unchanged hash refreshes the stamp without
 * re-embedding; a changed hash re-embeds ALL chunks of that doc.
 *
 * The whole store is invalidated (wiped + rebuilt) when the provider, model id,
 * dims, or chunking config change — that is what keeps a vector produced by one
 * provider/model from silently scoring against another's query (a mismatch is a
 * silent retrieval failure, not a loud one).
 *
 * Dims come in two flavours that must not be conflated. `identityDims` is what
 * the user configured (a number, or `'auto'` when they left it to the
 * provider), and it is the only one in the identity check. `dims` is the length
 * actually observed — pinned from the manifest on restart or from the first
 * embed, and compared for drift. Folding the observed length into the identity
 * would make an auto cache invalidate itself on every restart.
 *
 * Vectors are stored in platform-native Float32 byte order. The cache is
 * machine-local and never transported, so endianness is always self-consistent.
 */

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

/** On-disk manifest layout version — bump on any structural format change. */
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
  /** The concrete vector length these blobs were written at. */
  dims: number;
  /**
   * The dims component of the cache IDENTITY: the configured size, or `'auto'`
   * when the config leaves it to the provider. Absent in manifests written
   * before the split (see `manifestIdentityDims`).
   */
  identityDims?: number | 'auto';
  chunkConfigId: string;
  entries: Record<string, ManifestEntry>;
}

/** What the identity-dims component of a cache fingerprint can be. */
export type IdentityDims = number | 'auto';

/**
 * Identity dims for a manifest, tolerating the pre-split shape.
 *
 * A legacy manifest carries only `dims`, which was simultaneously the identity
 * and the value. Reading it back as `'auto'` when we are in auto mode is sound
 * — every stored vector was length-checked against that exact `dims` at write
 * time, so adopting them is the same guarantee a fresh detection would give —
 * and it is what keeps the upgrade from charging every existing user a full
 * re-embed.
 */
function manifestIdentityDims(manifest: ManifestFile, want: IdentityDims): IdentityDims {
  if (manifest.identityDims !== undefined) return manifest.identityDims;
  return want === 'auto' ? 'auto' : manifest.dims;
}

interface VectorCacheOptions {
  /** Cache home (`<projectDir>/.ok/local/embeddings`), or `null` for memory-only (tests). */
  cacheDir: string | null;
  providerId: string;
  modelId: string;
  /**
   * Configured vector length, or `null` for auto — the length is then pinned
   * from the manifest on restart, or from the first embed on a cold cache.
   */
  dims: number | null;
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
  // Copy into a fresh, 4-byte-aligned ArrayBuffer — a Buffer from readFile may
  // sit at a non-aligned byteOffset, which would reject a Float32Array view.
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

/**
 * The vector store. The semantic-search service owns the embed loop and calls
 * these methods; the cache owns persistence, content-addressing, incremental
 * identity, and GC. All mutation is in memory until {@link VectorCache.persist}.
 */
export class VectorCache {
  private readonly cacheDir: string | null;
  private readonly vecDir: string | null;
  private readonly manifestPath: string | null;
  readonly providerId: string;
  readonly modelId: string;
  /**
   * The dims component of this cache's identity — a number when configured,
   * `'auto'` when the provider decides. What gates the wipe. Deliberately NOT
   * the detected length: an auto cache whose identity moved with the detected
   * value would fail its own identity check on every restart and re-embed the
   * whole corpus each boot.
   */
  readonly identityDims: IdentityDims;
  readonly chunkConfigId: string;

  /** docId → manifest entry (contentHash + mtime stamp). */
  private readonly entries = new Map<string, ManifestEntry>();
  /** contentHash → chunk vectors (content-addressed; deduped across docs). */
  private readonly vectorsByHash = new Map<string, Float32Array[]>();
  /** contentHashes whose blob is already written to disk (skip re-write on persist). */
  private readonly persistedHashes = new Set<string>();
  /** Whether in-memory state has diverged from disk since the last persist. */
  private dirty = false;
  /** Concrete vector length; `null` until an auto cache pins one. */
  private pinnedDims: number | null;

  constructor(options: VectorCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.vecDir = options.cacheDir ? join(options.cacheDir, VEC_SUBDIR) : null;
    this.manifestPath = options.cacheDir ? join(options.cacheDir, MANIFEST_NAME) : null;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.identityDims = options.dims ?? 'auto';
    this.pinnedDims = options.dims;
    this.chunkConfigId = options.chunkConfigId;
  }

  /** Vector length in use, or `null` when auto and nothing is pinned yet. */
  get dims(): number | null {
    return this.pinnedDims;
  }

  /**
   * Record the length the provider actually returned, so `persist` knows what
   * these blobs are. Only ever fires on a cold auto cache: the embedder rejects
   * any response of a different size, so a change arrives as an error rather
   * than as a second pin.
   */
  pinDims(dims: number): void {
    this.pinnedDims ??= dims;
  }

  /** Throw the store away, memory AND disk, e.g. its vectors are the wrong size now. */
  discard(): void {
    this.entries.clear();
    this.vectorsByHash.clear();
    this.persistedHashes.clear();
    this.wipeDisk();
    this.dirty = false;
  }

  /**
   * Load the manifest + referenced blobs into memory. If the on-disk identity
   * (model/dims/chunk-config/schema) differs from this instance's, the store is
   * wiped and rebuilt — the single guard against cross-model vector mismatch.
   * Never throws: a corrupt or absent cache starts empty.
   */
  async init(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.vecDir) return;
    let manifest: ManifestFile | null = null;
    try {
      if (existsSync(this.manifestPath)) {
        manifest = JSON.parse(await readFile(this.manifestPath, 'utf-8')) as ManifestFile;
      }
    } catch (err) {
      log.warn({ err }, '[embeddings] unreadable cache manifest — rebuilding');
      manifest = null;
    }

    const identityMatches =
      manifest !== null &&
      manifest.schemaVersion === MANIFEST_SCHEMA_VERSION &&
      manifest.providerId === this.providerId &&
      manifest.modelId === this.modelId &&
      manifestIdentityDims(manifest, this.identityDims) === this.identityDims &&
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

    // Manifest-first: an auto cache takes its length from what was actually
    // written, not from a re-detection. Without this the restart path has no
    // length to deserialize with and would re-embed the whole corpus.
    if (this.pinnedDims === null) {
      if (!Number.isInteger(manifest.dims) || manifest.dims <= 0) return;
      this.pinnedDims = manifest.dims;
    }
    const dims = this.pinnedDims;

    for (const [docId, entry] of Object.entries(manifest.entries)) {
      if (!entry?.contentHash) continue;
      this.entries.set(docId, { contentHash: entry.contentHash, mtimeMs: entry.mtimeMs ?? 0 });
      if (!this.vectorsByHash.has(entry.contentHash)) {
        try {
          const blobPath = join(this.vecDir, `${entry.contentHash}.bin`);
          if (existsSync(blobPath)) {
            const bytes = await readFile(blobPath);
            this.vectorsByHash.set(entry.contentHash, deserializeVectors(bytes, dims));
            this.persistedHashes.add(entry.contentHash);
          }
        } catch (err) {
          // Corrupt blob → drop the in-memory vectors so the doc re-embeds.
          log.warn(
            { hash: entry.contentHash, err },
            '[embeddings] corrupt vector blob — will re-embed',
          );
        }
      }
    }
  }

  /** mtime pre-filter: vectors present AND the stamp matches — reuse without hashing. */
  isFresh(docId: string, mtimeMs: number): boolean {
    const entry = this.entries.get(docId);
    return (
      entry !== undefined && entry.mtimeMs === mtimeMs && this.vectorsByHash.has(entry.contentHash)
    );
  }

  /**
   * Reuse cached vectors for `contentHash` if any are held (same doc unchanged,
   * OR identical content already embedded under another doc). Refreshes the
   * doc's manifest entry and returns true; returns false when the content must
   * be embedded.
   */
  link(docId: string, contentHash: string, mtimeMs: number): boolean {
    if (!this.vectorsByHash.has(contentHash)) return false;
    const prev = this.entries.get(docId);
    if (!prev || prev.contentHash !== contentHash || prev.mtimeMs !== mtimeMs) this.dirty = true;
    this.entries.set(docId, { contentHash, mtimeMs });
    return true;
  }

  /** Store freshly-embedded chunk vectors for a (changed/new) document. */
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

  /** Number of documents with at least one cached chunk vector (coverage). */
  get embeddedCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      const v = this.vectorsByHash.get(entry.contentHash);
      if (v && v.length > 0) n += 1;
    }
    return n;
  }

  /** Drop entries (and now-unreferenced vectors) for docs no longer in the corpus. */
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

  /** Forget all in-memory vectors (e.g. the feature was disabled). Disk untouched. */
  clearMemory(): void {
    this.entries.clear();
    this.vectorsByHash.clear();
    this.persistedHashes.clear();
    // A discard leaves nothing to flush — reset `dirty` so an orphaned instance
    // still referenced by an in-flight embed pass can't later `persist()` an
    // empty manifest and GC the on-disk blobs. The disk store stays intact.
    this.dirty = false;
  }

  /** Write dirty blobs + the manifest atomically, then GC orphaned blob files. */
  async persist(): Promise<void> {
    if (!this.cacheDir || !this.manifestPath || !this.vecDir) return;
    if (!this.dirty) return; // nothing changed since last persist — skip the write
    const dims = this.pinnedDims;
    // Nothing has been embedded yet (or every doc in the corpus is blank, which
    // stores zero vectors), so there is no length to write and any entries are
    // empty ones that cost nothing to reconcile again next boot. Writing a null
    // length would poison the next init's deserialize.
    if (dims === null) return;
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
        dims,
        identityDims: this.identityDims,
        chunkConfigId: this.chunkConfigId,
        entries: Object.fromEntries(this.entries),
      };
      const tmp = `${this.manifestPath}.tmp`;
      await tracedWriteFile(tmp, JSON.stringify(manifest));
      await tracedRename(tmp, this.manifestPath);

      // GC: delete blob files no longer referenced by any entry.
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
      // Persistence is best-effort: an unwritable cache degrades to recompute
      // next boot, it must never fail a search or an embed pass.
      log.warn({ err }, '[embeddings] failed to persist vector cache');
    }
  }

  private wipeDisk(): void {
    if (!this.cacheDir) return;
    try {
      tracedRmSync(this.cacheDir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ err }, '[embeddings] failed to wipe stale cache');
    }
  }
}
