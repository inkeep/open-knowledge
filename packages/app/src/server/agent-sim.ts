
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseApiError } from '../lib/parse-api-error.ts';

const args = process.argv.slice(2);

const useMarkdown = args.includes('--markdown');
const usePatch = args.includes('--patch');
const useFile = args.includes('--file');
const rapidIndex = args.indexOf('--rapid');
const count = rapidIndex >= 0 ? Number.parseInt(args[rapidIndex + 1] || '5', 10) : 1;

const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] || '5173', 10) : 5173;

const docIndex = args.indexOf('--doc');
const docName = docIndex >= 0 ? (args[docIndex + 1] ?? 'test-doc') : 'test-doc';

const intervalIndex = args.indexOf('--interval');
const intervalMs =
  intervalIndex >= 0 ? Number.parseInt(args[intervalIndex + 1] || '2000', 10) : 2000;

const DEFAULT_CONTENT_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../../../content',
);
const contentDirIndex = args.indexOf('--content-dir');
const contentDir =
  contentDirIndex >= 0
    ? resolve(args[contentDirIndex + 1] ?? DEFAULT_CONTENT_DIR)
    : DEFAULT_CONTENT_DIR;

const BASE_URL = `http://localhost:${port}`;

if (usePatch && (useMarkdown || rapidIndex >= 0)) {
  console.error('Error: --patch is mutually exclusive with --markdown and --rapid.');
  process.exit(1);
}
if (useFile && (usePatch || useMarkdown || rapidIndex >= 0)) {
  console.error('Error: --file is mutually exclusive with --patch, --markdown, and --rapid.');
  process.exit(1);
}


type WriteResult = { ok: boolean; timestamp?: string; error?: string; type?: string };

async function parseWriteResponse(res: Response): Promise<WriteResult> {
  const body = (await res.json().catch(() => null)) as {
    timestamp?: unknown;
    type?: unknown;
  } | null;
  if (!res.ok) {
    return {
      ok: false,
      error: parseApiError(body) ?? `HTTP ${res.status}`,
      type: typeof body?.type === 'string' ? body.type : undefined,
    };
  }
  return {
    ok: true,
    timestamp: typeof body?.timestamp === 'string' ? body.timestamp : undefined,
  };
}

async function agentWriteRaw(): Promise<WriteResult> {
  const res = await fetch(`${BASE_URL}/api/agent-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, content: 'Agent raw write.\n' }),
  });
  return parseWriteResponse(res);
}

const SIM_AGENT_ID = 'agent-sim-001';
const SIM_AGENT_NAME = 'agent-sim';

async function agentWriteMarkdown(
  markdown: string,
  position: 'append' | 'prepend' | 'replace' = 'append',
): Promise<WriteResult> {
  const res = await fetch(`${BASE_URL}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown,
      position,
      docName,
      agentId: SIM_AGENT_ID,
      agentName: SIM_AGENT_NAME,
    }),
  });
  return parseWriteResponse(res);
}

async function agentPatch(find: string, replace: string): Promise<WriteResult> {
  const res = await fetch(`${BASE_URL}/api/agent-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      find,
      replace,
      docName,
      agentId: SIM_AGENT_ID,
      agentName: SIM_AGENT_NAME,
    }),
  });
  return parseWriteResponse(res);
}

async function readDocument(): Promise<{ ok: boolean; content?: string; error?: string }> {
  const res = await fetch(`${BASE_URL}/api/document?docName=${encodeURIComponent(docName)}`);
  const body = (await res.json().catch(() => null)) as {
    docName?: unknown;
    content?: unknown;
    type?: unknown;
    title?: unknown;
  } | null;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body?.title === 'string' ? body.title : `HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    content: typeof body?.content === 'string' ? body.content : '',
  };
}


async function doWrite(index: number) {
  const timestamp = new Date().toISOString();
  try {
    let result: { ok: boolean; timestamp?: string; error?: string };
    if (useMarkdown) {
      result = await agentWriteMarkdown(`Agent markdown write at ${timestamp}`, 'append');
    } else {
      result = await agentWriteRaw();
    }

    if (result.ok) {
      console.log(
        `  [write ${index}] OK — awareness: editing→idle, activity map updated, origin: agent-write`,
      );
    } else {
      console.error(`  [write ${index}] FAIL — ${result.error ?? 'unknown error'}`);
    }
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`  [write ${index}] ERROR — ${message}`);
    console.error('    Is the dev server running? (bun run dev)');
    return { ok: false, error: message };
  }
}


const PATCH_TEMPLATE = `# Test Document

## Status

Status: pending

## Notes

No notes yet.

## Next Steps

TBD`;

const PATCH_SEQUENCE: Array<{ find: string; replace: string }> = [
  { find: 'pending', replace: 'in progress' },
  { find: 'No notes yet.', replace: 'Notes added by agent.' },
  { find: 'TBD', replace: 'Review patch behavior' },
  { find: 'in progress', replace: 'complete' },
];

async function runPatchMode() {
  console.log(`\n--- Agent Simulator (v4) — patch mode ---`);
  console.log(`Doc: ${docName}`);
  console.log(`Port: ${port}`);
  console.log(`Interval: ${intervalMs}ms between patches\n`);

  let content: string;
  try {
    const docResult = await readDocument();
    if (!docResult.ok) {
      console.error(`Failed to read document: ${docResult.error ?? 'unknown error'}`);
      process.exit(1);
    }
    content = docResult.content ?? '';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`ERROR reading document — ${message}`);
    console.error('  Is the dev server running? (bun run dev)');
    process.exit(1);
  }

  const hasRecognizableSections =
    content.includes('Status: pending') ||
    content.includes('Status: in progress') ||
    content.includes('No notes yet.') ||
    content.includes('TBD');

  if (content.trim().length === 0 || !hasRecognizableSections) {
    console.log('Document empty or missing patch targets — seeding with template...');
    try {
      const seedResult = await agentWriteMarkdown(PATCH_TEMPLATE, 'replace');
      if (seedResult.ok) {
        console.log('  Seeded document with template.\n');
      } else {
        console.error(`  Seed FAIL — ${seedResult.error ?? 'unknown error'}`);
        process.exit(1);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`  ERROR seeding document — ${message}`);
      process.exit(1);
    }
  } else {
    console.log('Document already contains patch targets — skipping seed.\n');
  }

  for (let i = 0; i < PATCH_SEQUENCE.length; i++) {
    const { find, replace } = PATCH_SEQUENCE[i];
    console.log(`  [patch ${i + 1}/${PATCH_SEQUENCE.length}]`);
    console.log(`    find:    "${find}"`);
    console.log(`    replace: "${replace}"`);

    try {
      const result = await agentPatch(find, replace);
      if (result.ok) {
        console.log(`    OK — patch applied`);
      } else if (result.type === 'urn:ok:error:target-not-found') {
        console.log(`    not found — skipping`);
      } else {
        console.error(`    FAIL — ${result.error ?? 'unknown error'}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`    ERROR — ${message}`);
    }

    if (i < PATCH_SEQUENCE.length - 1) {
      console.log(`    waiting ${intervalMs}ms...`);
      await wait(intervalMs);
    }
  }

  console.log('\nPatch sequence complete.');
}


async function runFileMode() {
  const filePath = resolve(contentDir, `${docName}.md`);

  console.log(`\n--- Agent Simulator (v4) — file mode ---`);
  console.log(`WARNING: This mode bypasses the CRDT entirely.`);
  console.log(`  Edits go: disk write -> file watcher -> Y.Text (not directly to Y.Text).`);
  console.log(`  The stale-read window between disk write and CRDT sync is intentionally visible.`);
  console.log(`Doc:         ${docName}`);
  console.log(`File:        ${filePath}`);
  console.log(`Port:        ${port}`);
  console.log(`Interval:    ${intervalMs}ms between edits\n`);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    content = '';
  }

  const hasRecognizableSections =
    content.includes('Status: pending') ||
    content.includes('Status: in progress') ||
    content.includes('No notes yet.') ||
    content.includes('TBD');

  if (content.trim().length === 0 || !hasRecognizableSections) {
    console.log('File empty or missing patch targets — seeding directly to disk...');
    writeFileSync(filePath, PATCH_TEMPLATE, 'utf8');
    content = PATCH_TEMPLATE;
    console.log('  Seeded file with template.');
    console.log(`  Waiting 1500ms for file watcher sync...\n`);
    await wait(1500);
  } else {
    console.log('File already contains patch targets — skipping seed.\n');
  }

  for (let i = 0; i < PATCH_SEQUENCE.length; i++) {
    const { find, replace } = PATCH_SEQUENCE[i];
    console.log(`  [file-edit ${i + 1}/${PATCH_SEQUENCE.length}]`);
    console.log(`    find:    "${find}"`);
    console.log(`    replace: "${replace}"`);

    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
    }

    if (content.includes(find)) {
      const updated = content.replace(find, replace);
      writeFileSync(filePath, updated, 'utf8');
      content = updated;
      console.log(`    OK — found and applied (wrote to disk)`);
    } else {
      console.log(`    not found in file (may be in-flight in CRDT)`);
    }

    if (i < PATCH_SEQUENCE.length - 1) {
      console.log(`    waiting ${intervalMs}ms...`);
      await wait(intervalMs);
    }
  }

  console.log('\nFile edit sequence complete.');
  console.log('The file watcher will propagate changes to Y.Text asynchronously.');
}


if (usePatch) {
  await runPatchMode();
} else if (useFile) {
  await runFileMode();
} else {
  console.log(`\n--- Agent Simulator (v4) ---`);
  console.log(`Mode: ${useMarkdown ? 'markdown' : 'raw'}`);
  console.log(`Writes: ${count}${count > 1 ? ' (rapid, 100ms apart)' : ''}`);
  console.log(`Presence: Agent connects with awareness (Claude, #D97757, type: agent)`);
  console.log(`Activity: Y.Map('agent-flash') updated per write for flash plugins`);
  console.log(`Undo: writes tracked with 'agent-write' origin\n`);

  if (count > 1) {
    for (let i = 0; i < count; i++) {
      await doWrite(i + 1);
      if (i < count - 1) {
        await wait(100);
      }
    }
  } else {
    await doWrite(1);
  }

  console.log('\nDone. Check the browser for:');
  console.log('  - Agent in presence bar (Claude badge)');
  console.log('  - Region flash on new content');
  console.log('  - "Undo Agent Edit" button enabled');
}
