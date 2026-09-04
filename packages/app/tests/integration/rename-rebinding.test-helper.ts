import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OLD_FOLDER = 'offsite/liveblocks';
export const NEW_PARENT = 'offsite/2026-08-31-day-1';
export const NEW_FOLDER = `${NEW_PARENT}/liveblocks`;
export const OLD_DOC = `${OLD_FOLDER}/liveblocks`;
export const NEW_DOC = `${NEW_FOLDER}/liveblocks`;

export const BODY = [
  '# Liveblocks',
  '',
  '## What is it',
  '',
  'A real-time collaboration platform.',
  '',
  '## Core collaboration features',
  '',
  '### Multiplayer editing',
  '',
  'Build real-time editors.',
  '',
  '## Why // Is it cool?',
  '',
  'Architecture.',
  '',
  '## What can you do with it?',
  '',
  '### Comments',
  '',
  'Threaded comments.',
  '',
].join('\n');

export const BODY_HEADING_COUNT = 7;

export async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

export async function getHeadings(port: number, docName: string) {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/page-headings?docName=${encodeURIComponent(docName)}`,
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
}

export function seedRenameFixtureContentDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  /* STOP: every folder these tests rename into must exist before the server
     boots. The watcher arms its recursive watch at subscribe time, so a folder
     created after boot can miss the events for files moved into it, and the
     file index has no prune path that recovers from a missed delete. */
  for (const folder of [OLD_FOLDER, NEW_FOLDER]) {
    mkdirSync(join(dir, folder), { recursive: true });
  }
  writeFileSync(join(dir, `${OLD_DOC}.md`), BODY, 'utf-8');
  return dir;
}
