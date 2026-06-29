
export const CHUNK_TARGET_CHARS = 8000;

export const CHUNK_OVERLAP_CHARS = 400;

export const MAX_CHUNKS_PER_DOC = 80;

export const CHUNK_CONFIG_ID = `c${CHUNK_TARGET_CHARS}-o${CHUNK_OVERLAP_CHARS}-m${MAX_CHUNKS_PER_DOC}`;

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

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
