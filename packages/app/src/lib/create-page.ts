import { CreatePageSuccessSchema } from '@inkeep/open-knowledge-core/schemas/api';
import { emitDocumentsChanged } from './documents-events';
import { parseServerResponse, parseSuccessOrWarn } from './parse-server-response';

export interface CreatePageSeed {
  initialDir: string;
  suggestedName: string;
}

function ensureDocExtension(name: string): string {
  const trimmed = name.trim();
  if (/\.(md|mdx)$/i.test(trimmed)) return trimmed;
  return `${trimmed}.md`;
}

export function createPagePathFromSeed(seed: CreatePageSeed): string {
  const dir = seed.initialDir.trim().replace(/^\/+|\/+$/g, '');
  const fileName = ensureDocExtension(seed.suggestedName);
  return dir ? `${dir}/${fileName}` : fileName;
}

async function createPageFromPath(path: string): Promise<{ docName: string }> {
  const res = await fetch('/api/create-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  const parsed = await parseServerResponse(res, 'Failed to create page');
  if (!parsed.ok) {
    throw new Error(parsed.title);
  }

  const fallbackDocName = path.replace(/\.(mdx|md)$/i, '');
  const success = parseSuccessOrWarn(CreatePageSuccessSchema, parsed.body, 'create-page', {
    docName: fallbackDocName,
  });
  return { docName: success.docName };
}

async function createPageFromSeed(seed: CreatePageSeed): Promise<{ docName: string }> {
  return createPageFromPath(createPagePathFromSeed(seed));
}

export async function createPageFromSeedAndUpdate(
  seed: CreatePageSeed,
  options: {
    addPage: (docName: string) => void;
    onCreated?: (docName: string) => void;
  },
): Promise<{ docName: string }> {
  const { docName } = await createPageFromSeed(seed);
  options.addPage(docName);
  emitDocumentsChanged(['files', 'backlinks', 'graph']);
  options.onCreated?.(docName);
  return { docName };
}
