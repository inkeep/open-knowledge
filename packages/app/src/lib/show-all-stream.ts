import { type DocumentListEntry, DocumentListEntrySchema } from '@inkeep/open-knowledge-core';

export const SHOW_ALL_NDJSON_ACCEPT = { Accept: 'application/x-ndjson, application/json' } as const;

interface ShowAllStreamResult {
  entries: DocumentListEntry[];
  truncated: boolean;
}

export function isNdjsonResponse(res: Response): boolean {
  if (!res.ok || !res.body) return false;
  const contentType = res.headers.get('content-type') ?? '';
  return contentType.includes('application/x-ndjson');
}

export class ShowAllStreamError extends Error {}

type ControlEvent =
  | { type: 'complete'; truncated?: unknown; count?: unknown }
  | { type: 'error'; problem?: { title?: unknown } };

function isControlEvent(value: unknown): value is ControlEvent {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export interface ConsumeShowAllStreamOptions {
  onBatch?: (batch: DocumentListEntry[]) => void;
}

export async function consumeShowAllStream(
  res: Response,
  options: ConsumeShowAllStreamOptions = {},
): Promise<ShowAllStreamResult> {
  const body = res.body;
  if (!body) throw new ShowAllStreamError('Show All Files stream had no response body.');

  const { onBatch } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const entries: DocumentListEntry[] = [];
  let pendingBatch: DocumentListEntry[] = [];
  let truncated = false;
  let buffer = '';

  const ingestLine = (rawLine: string): boolean => {
    const line = rawLine.trim();
    if (line.length === 0) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[show-all-stream] dropping unparseable NDJSON line:', line.slice(0, 200));
      return false;
    }
    if (isControlEvent(parsed)) {
      if (parsed.type === 'error') {
        const title =
          typeof parsed.problem?.title === 'string'
            ? parsed.problem.title
            : 'Show All Files stream failed.';
        throw new ShowAllStreamError(title);
      }
      truncated = parsed.truncated === true;
      return true;
    }
    const result = DocumentListEntrySchema.safeParse(parsed);
    if (result.success) {
      entries.push(result.data);
      pendingBatch.push(result.data);
    } else {
      console.warn('[show-all-stream] dropping schema-divergent entry line:', result.error.issues);
    }
    return false;
  };

  const flushBatch = (): void => {
    if (!onBatch || pendingBatch.length === 0) return;
    const batch = pendingBatch;
    pendingBatch = [];
    onBatch(batch);
  };

  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const completed = ingestLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (completed) {
          done = true;
          break;
        }
        newlineIndex = buffer.indexOf('\n');
      }
      flushBatch();
    }
    buffer += decoder.decode();
    if (!buffer.includes('\n')) ingestLine(buffer);
    flushBatch();
  } finally {
    reader.releaseLock();
  }

  return { entries, truncated };
}
