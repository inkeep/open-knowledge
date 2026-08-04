import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { parseServerResponse } from '@/lib/parse-server-response';
import {
  consumeShowAllStream,
  isNdjsonResponse,
  SHOW_ALL_NDJSON_ACCEPT,
  ShowAllStreamError,
} from '@/lib/show-all-stream';
import { type FileEntry, toFileEntries } from './file-tree-utils';

export type ShowAllDepth1ListingResult =
  | { kind: 'entries'; entries: FileEntry[]; truncated: boolean }
  | { kind: 'http-error'; title: string; cause?: unknown }
  | { kind: 'network-error'; cause: unknown };

export interface FileTreeListingRequest {
  dir: string;
  showOk: boolean;
  signal: AbortSignal;
  onBatch?: (entries: FileEntry[]) => void;
  messages: {
    fallbackErrorTitle: string;
    schemaMismatchTitle: string;
  };
}

export interface FileTreeListingSource {
  listDepthOne(request: FileTreeListingRequest): Promise<ShowAllDepth1ListingResult>;
}

export function showAllDepth1Url(dir: string, showOk: boolean): string {
  return `/api/documents?showAll=true${showOk ? '&showOk=true' : ''}&dir=${encodeURIComponent(dir)}&depth=1`;
}

export async function fetchShowAllDepth1Listing({
  dir,
  showOk,
  signal,
  onBatch,
  messages,
}: FileTreeListingRequest): Promise<ShowAllDepth1ListingResult> {
  try {
    const response = await fetch(showAllDepth1Url(dir, showOk), {
      signal,
      headers: SHOW_ALL_NDJSON_ACCEPT,
    });
    if (isNdjsonResponse(response)) {
      const consumed = await consumeShowAllStream(response, {
        onBatch: onBatch ? (entries) => onBatch(toFileEntries(entries)) : undefined,
      });
      return {
        kind: 'entries',
        entries: toFileEntries(consumed.entries),
        truncated: consumed.truncated,
      };
    }
    const parsed = await parseServerResponse(response, messages.fallbackErrorTitle);
    if (!parsed.ok) return { kind: 'http-error', title: parsed.title };
    const success = DocumentListSuccessSchema.safeParse(parsed.body);
    if (!success.success) {
      return { kind: 'http-error', title: messages.schemaMismatchTitle };
    }
    return {
      kind: 'entries',
      entries: toFileEntries(success.data.documents),
      truncated: success.data.truncated === true,
    };
  } catch (cause) {
    if (cause instanceof ShowAllStreamError) {
      return { kind: 'http-error', title: cause.message, cause };
    }
    return { kind: 'network-error', cause };
  }
}

export const httpFileTreeListingSource: FileTreeListingSource = {
  listDepthOne: fetchShowAllDepth1Listing,
};
