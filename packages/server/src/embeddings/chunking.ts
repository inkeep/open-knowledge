/**
 * Passage chunking for long documents.
 *
 * `text-embedding-3` truncates at ~8191 tokens, so most knowledge-base docs
 * embed whole as a single chunk (the common case). Only genuinely long docs are
 * split into overlapping passages; the doc score rolls up as the MAX chunk
 * cosine, rewarding the single best-matching passage.
 *
 * Chunking is sized in CHARACTERS, not tokens, deliberately: a character budget
 * keeps this a pure function with no tokenizer dependency, so the deterministic
 * concept embedder chunks identically to the remote one. {@link CHUNK_TARGET_CHARS}
 * is set conservatively below the provider's token limit — even at a pessimistic
 * ~2 chars/token (code / CJK) an 8000-char window is ~4000 tokens, comfortably
 * under 8191 — so a token-dense passage can never overflow a single request.
 *
 * Changing any of these constants changes the vectors a given document produces,
 * so {@link CHUNK_CONFIG_ID} is folded into the vector-cache key — bumping a
 * constant transparently invalidates stale cached vectors.
 */

/** Target characters per chunk (~2–4k tokens, safely under the 8191 limit). */
export const CHUNK_TARGET_CHARS = 8000;

/** Overlap between consecutive chunks (~5%), so a match spanning a boundary survives. */
export const CHUNK_OVERLAP_CHARS = 400;

/**
 * Upper bound on chunks per document. KB docs are typically 1 chunk; this only
 * bounds pathologically large files (≈600 KB+) so a single doc can't pin the
 * embed queue. Exceeding it embeds the head and drops the tail — an acceptable
 * bound for files far larger than any real note.
 */
export const MAX_CHUNKS_PER_DOC = 80;

/**
 * Identity of the chunking configuration — part of the vector-cache key. Encodes
 * every constant that affects the vectors a document produces, including
 * {@link MAX_CHUNKS_PER_DOC} (bumping it adds/drops tail chunks on very large
 * docs), so changing any of them transparently invalidates stale cached vectors.
 */
export const CHUNK_CONFIG_ID = `c${CHUNK_TARGET_CHARS}-o${CHUNK_OVERLAP_CHARS}-m${MAX_CHUNKS_PER_DOC}`;

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

/**
 * Split `text` into overlapping passages. Returns `[]` for blank input and a
 * single chunk for anything within the target budget (the common case). Chunk
 * boundaries snap back to the nearest whitespace within the window so a passage
 * never cuts mid-word.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): string[] {
  const target = Math.max(1, options.targetChars ?? CHUNK_TARGET_CHARS);
  const overlap = Math.max(0, Math.min(options.overlapChars ?? CHUNK_OVERLAP_CHARS, target - 1));
  const maxChunks = options.maxChunks ?? MAX_CHUNKS_PER_DOC;

  if (text.trim().length === 0) return [];
  if (text.length <= target) return [text.trim()];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, start + target);
    if (end < text.length) {
      // Snap back to the last whitespace in the window so we don't split a
      // word — but only if that boundary is past the chunk's midpoint, else a
      // long unbroken run would collapse the chunk to nothing.
      const boundary = Math.max(text.lastIndexOf(' ', end), text.lastIndexOf('\n', end));
      if (boundary > start + Math.floor(target / 2)) end = boundary;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    const next = end - overlap;
    start = next > start ? next : end; // guarantee forward progress
  }
  return chunks;
}
