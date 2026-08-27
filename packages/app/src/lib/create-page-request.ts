import { CreatePageSuccessSchema } from '@inkeep/open-knowledge-core';
// The core macro, not `useLingui()`: this module is called from a plain
// keydown listener (App's new-item shortcut) as well as from React, so the
// messages have to resolve against the active catalog at call time.
import { t } from '@lingui/core/macro';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { parseServerResponse } from '@/lib/parse-server-response';
import { hashFromDocName } from './doc-hash';

/**
 * `POST /api/create-page` with the canonical response parse.
 *
 * Shared by `NewItemDialog` (which renders `error` inline) and the dialogless
 * Cmd+N fast path in `App.tsx` (which toasts `error` before falling back to
 * the dialog). Never throws — a network failure comes back as `{ ok: false }`
 * like a server rejection, so callers branch on `ok` instead of try/catch.
 *
 * Sibling `create-page.ts` wraps the same endpoint but throws instead of
 * returning a result union — new callers should prefer this never-throw shape.
 */
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

/**
 * Post-create tail shared by every create surface: navigate to the new doc,
 * seed it into the page list optimistically, and fan out the change event.
 */
export function openCreatedPage(docName: string, addPage: (docName: string) => void) {
  window.location.hash = hashFromDocName(docName);
  addPage(docName);
  emitDocumentsChanged(['files', 'backlinks', 'graph']);
}

/**
 * First free `untitled`, `untitled-2`, `untitled-3`, … docName in `dir`,
 * against the docNames the page list already knows about. Extension-less,
 * matching `PageListContext`'s `pages` set — callers append `.md`.
 *
 * Lowercase + hyphen (unlike the file-tree's transient `Untitled N`): this name
 * persists as the doc's filename and URL hash, so it stays URL-safe, and it
 * matches `doc-paths.ts`'s `untitled` fallback.
 */
export function nextUntitledDocName(dir: string, takenDocNames: ReadonlySet<string>): string {
  const prefix = dir ? `${dir}/` : '';
  for (let n = 1; ; n++) {
    const candidate = `${prefix}untitled${n === 1 ? '' : `-${n}`}`;
    if (!takenDocNames.has(candidate)) return candidate;
  }
}
