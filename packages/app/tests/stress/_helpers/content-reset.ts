
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_FIXTURE_ENTRY_NAMES } from './fixtures.ts';

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

export async function resetContentToFixtureBaseline(
  baseURL: string,
  contentDir: string,
): Promise<void> {
  const preserved = new Set<string>(REQUIRED_FIXTURE_ENTRY_NAMES);
  for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (preserved.has(entry.name)) continue;
    if (entry.isDirectory()) {
      await deletePathIfExists(baseURL, 'folder', entry.name);
      continue;
    }
    const docName = entry.name.replace(/\.(md|mdx)$/i, '');
    if (docName !== entry.name) {
      await deletePathIfExists(baseURL, 'file', docName);
      continue;
    }
    rmSync(join(contentDir, entry.name), { recursive: true, force: true });
  }
}
