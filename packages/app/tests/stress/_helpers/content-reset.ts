import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_FIXTURE_DOC_NAMES, REQUIRED_FIXTURE_ENTRY_NAMES } from './fixtures.ts';

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
