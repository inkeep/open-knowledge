import { CreatePageSuccessSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { parseServerResponse } from '@/lib/parse-server-response';
import { hashFromDocName } from './doc-hash';

export async function createPageRequest(args: {
  path: string;
  template?: string;
  kind: 'file' | 'folder';
}): Promise<{ ok: true; docName: string } | { ok: false; error: string }> {
  const requestBody: { path: string; template?: string } = { path: args.path };
  if (args.template !== undefined) requestBody.template = args.template;

  try {
    const res = await fetch('/api/create-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const status = res.status;
    const parsed = await parseServerResponse(res, t`Server error (HTTP ${status})`);
    if (!parsed.ok) return { ok: false, error: parsed.title };
    const success = CreatePageSuccessSchema.safeParse(parsed.body);
    if (!success.success) {
      return {
        ok: false,
        error: args.kind === 'folder' ? t`Failed to create folder` : t`Failed to create file`,
      };
    }
    return { ok: true, docName: success.data.docName };
  } catch (err) {
    console.warn('[create-page-request] create failed:', err);
    return { ok: false, error: t`Network error — please try again` };
  }
}

export function openCreatedPage(docName: string, addPage: (docName: string) => void) {
  window.location.hash = hashFromDocName(docName);
  addPage(docName);
  emitDocumentsChanged(['files', 'backlinks', 'graph']);
}

export function nextUntitledDocName(dir: string, takenDocNames: ReadonlySet<string>): string {
  const prefix = dir ? `${dir}/` : '';
  for (let n = 1; ; n++) {
    const candidate = `${prefix}untitled${n === 1 ? '' : `-${n}`}`;
    if (!takenDocNames.has(candidate)) return candidate;
  }
}
