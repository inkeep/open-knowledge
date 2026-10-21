import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  TemplateDeleteSuccessSchema,
  TemplatesListSuccessSchema,
} from '@inkeep/open-knowledge-core/schemas/api';
import { REQUIRED_FIXTURE_DOC_NAMES, REQUIRED_FIXTURE_ENTRY_NAMES } from './fixtures.ts';

async function readTemplateInventory(baseURL: string, requestTimeoutMs: number) {
  const res = await fetch(`${baseURL}/api/templates`, {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`GET /api/templates failed: ${res.status} ${await res.text()}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    throw new Error(`GET /api/templates returned invalid JSON: ${String(error)}`);
  }
  const parsed = TemplatesListSuccessSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`GET /api/templates returned an invalid response: ${parsed.error.message}`);
  }
  if (parsed.data.truncated) {
    throw new Error('GET /api/templates returned a truncated inventory');
  }
  return parsed.data.templates;
}

async function deleteTemplate(
  baseURL: string,
  folder: string,
  name: string,
  requestTimeoutMs: number,
): Promise<void> {
  const query = new URLSearchParams({ folder, name });
  const res = await fetch(`${baseURL}/api/template?${query}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(
      `DELETE /api/template failed for ${folder}/${name}: ${res.status} ${await res.text()}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    throw new Error(
      `DELETE /api/template returned invalid JSON for ${folder}/${name}: ${String(error)}`,
    );
  }
  const parsed = TemplateDeleteSuccessSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `DELETE /api/template returned an invalid response for ${folder}/${name}: ${parsed.error.message}`,
    );
  }
  if (!parsed.data.existed) {
    throw new Error(`DELETE /api/template made no progress for ${folder}/${name}`);
  }
}

async function deletePathIfExists(
  baseURL: string,
  kind: 'file' | 'folder',
  path: string,
): Promise<void> {
  const res = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });
  if (res.ok || res.status === 404) return;
  throw new Error(`delete-path failed for ${kind}:${path}: ${res.status} ${await res.text()}`);
}

async function removeEntriesOutside(
  baseURL: string,
  contentDir: string,
  folder: string,
  preserved: ReadonlySet<string>,
): Promise<void> {
  for (const entry of readdirSync(join(contentDir, folder), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (preserved.has(entry.name)) continue;
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      await deletePathIfExists(baseURL, 'folder', path);
      continue;
    }
    const docName = path.replace(/\.(md|mdx)$/i, '');
    if (docName !== path) {
      await deletePathIfExists(baseURL, 'file', docName);
      continue;
    }
    rmSync(join(contentDir, path), { recursive: true, force: true });
  }
}

export async function resetContentToFixtureBaseline(
  baseURL: string,
  contentDir: string,
): Promise<void> {
  await removeEntriesOutside(baseURL, contentDir, '', new Set(REQUIRED_FIXTURE_ENTRY_NAMES));
}

export async function resetTemplateInventory(
  baseURL: string,
  requestTimeoutMs: number,
): Promise<void> {
  const templates = await readTemplateInventory(baseURL, requestTimeoutMs);
  if (templates.length === 0) return;
  for (const template of templates) {
    await deleteTemplate(baseURL, template.source_folder, template.name, requestTimeoutMs);
  }
  const remaining = await readTemplateInventory(baseURL, requestTimeoutMs);
  if (remaining.length > 0) {
    const names = remaining.map((template) => `${template.source_folder}/${template.name}`);
    throw new Error(
      `template inventory reset did not reach an empty inventory: ${names.join(', ')} remain`,
    );
  }
}

export async function resetFixtureFolders(baseURL: string, contentDir: string): Promise<void> {
  const preservedByFolder = new Map<string, Set<string>>();
  for (const docName of REQUIRED_FIXTURE_DOC_NAMES) {
    const slash = docName.lastIndexOf('/');
    if (slash === -1) continue;
    const folder = docName.slice(0, slash);
    const preserved = preservedByFolder.get(folder) ?? new Set<string>();
    preserved.add(`${docName.slice(slash + 1)}.md`);
    preservedByFolder.set(folder, preserved);
  }
  for (const [folder, preserved] of preservedByFolder) {
    await removeEntriesOutside(baseURL, contentDir, folder, preserved);
  }
}
