import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CONTENT_DIR_TOKEN = '<CONTENT_DIR>';
const HASH_PREFIX = 'doc:';
const HASH_HEX_LEN = 8;
const DOC_NAME_KEYS = new Set(['doc.name']);

export interface RedactStagedBundleOpts {
  stagingDir: string;
  contentDir: string;
}

export interface RedactStagedBundleResult {
  docNameMap: Record<string, string>;
  docNameCollisions: Record<string, string[]>;
}

interface RedactCtx {
  contentDir: string;
  docNameMap: Record<string, string>;
  originalToHashed: Map<string, string>;
  docNameCollisions: Record<string, string[]>;
}

function hashDocName(value: string): string {
  const digest = createHash('blake2b512', { outputLength: 32 }).update(value).digest('hex');
  return `${HASH_PREFIX}${digest.slice(0, HASH_HEX_LEN)}`;
}

function recordHash(ctx: RedactCtx, value: string, hashed: string): void {
  const prev = ctx.docNameMap[hashed];
  if (prev === undefined) {
    ctx.docNameMap[hashed] = value;
    return;
  }
  if (prev === value) return;
  const existing = ctx.docNameCollisions[hashed];
  if (existing) {
    if (!existing.includes(value)) existing.push(value);
  } else {
    ctx.docNameCollisions[hashed] = [value];
  }
}

export const _recordHashForTests = recordHash;

function hashOrLookup(value: string, ctx: RedactCtx): string {
  const cached = ctx.originalToHashed.get(value);
  if (cached !== undefined) return cached;
  const hashed = hashDocName(value);
  ctx.originalToHashed.set(value, hashed);
  recordHash(ctx, value, hashed);
  return hashed;
}

function replaceContentDir(value: string, contentDir: string): string {
  if (contentDir.length === 0) return value;
  if (!value.includes(contentDir)) return value;
  return value.split(contentDir).join(CONTENT_DIR_TOKEN);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function redactValue(node: unknown, ctx: RedactCtx): unknown {
  if (typeof node === 'string') {
    return replaceContentDir(node, ctx.contentDir);
  }
  if (Array.isArray(node)) {
    return node.map((item) => redactValue(item, ctx));
  }
  if (!isObject(node)) {
    return node;
  }

  const otlpStringValue =
    typeof node.key === 'string' &&
    DOC_NAME_KEYS.has(node.key) &&
    isObject(node.value) &&
    typeof (node.value as Record<string, unknown>).stringValue === 'string'
      ? ((node.value as Record<string, unknown>).stringValue as string)
      : null;

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (otlpStringValue !== null && k === 'value' && isObject(v)) {
      const hashed = hashOrLookup(otlpStringValue, ctx);
      result[k] = { ...v, stringValue: hashed };
    } else if (DOC_NAME_KEYS.has(k) && typeof v === 'string') {
      result[k] = hashOrLookup(v, ctx);
    } else {
      result[k] = redactValue(v, ctx);
    }
  }
  return result;
}

function substringScrubDocNames(content: string, ctx: RedactCtx): string {
  if (ctx.originalToHashed.size === 0) return content;
  const ordered = Array.from(ctx.originalToHashed.entries()).sort(
    ([a], [b]) => b.length - a.length,
  );
  let out = content;
  for (const [original, hashed] of ordered) {
    if (original.length === 0) continue;
    if (!out.includes(original)) continue;
    out = out.split(original).join(hashed);
  }
  return out;
}

function redactJsonlFile(filePath: string, ctx: RedactCtx): void {
  const content = readFileSync(filePath, 'utf-8');
  if (content.length === 0) return;
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i === lines.length - 1 && line === '') continue;
    if (line.length === 0) {
      out.push('');
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const redacted = redactValue(parsed, ctx);
      out.push(JSON.stringify(redacted));
    } catch {
      out.push(line);
    }
  }
  const newContent = hasTrailingNewline ? `${out.join('\n')}\n` : out.join('\n');
  writeFileSync(filePath, newContent);
}

function redactJsonFile(filePath: string, ctx: RedactCtx): void {
  const content = readFileSync(filePath, 'utf-8');
  if (content.trim().length === 0) return;
  try {
    const parsed = JSON.parse(content);
    const redacted = redactValue(parsed, ctx);
    const trailingNewline = content.endsWith('\n') ? '\n' : '';
    writeFileSync(filePath, `${JSON.stringify(redacted, null, 2)}${trailingNewline}`);
  } catch {
    const contentDirReplaced = replaceContentDir(content, ctx.contentDir);
    const docNameScrubbed = substringScrubDocNames(contentDirReplaced, ctx);
    if (docNameScrubbed !== content) writeFileSync(filePath, docNameScrubbed);
  }
}

function redactPlainFile(filePath: string, ctx: RedactCtx): void {
  const content = readFileSync(filePath, 'utf-8');
  const replaced = replaceContentDir(content, ctx.contentDir);
  if (replaced !== content) writeFileSync(filePath, replaced);
}

function walkDirFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

const STATE_JSON_FILES = new Set(['agent-presence.json', 'runtime.json']);

export function redactStagedBundle(opts: RedactStagedBundleOpts): RedactStagedBundleResult {
  const ctx: RedactCtx = {
    contentDir: opts.contentDir,
    docNameMap: {},
    originalToHashed: new Map(),
    docNameCollisions: {},
  };

  for (const subdir of ['telemetry', 'logs', 'process']) {
    for (const filePath of walkDirFiles(join(opts.stagingDir, subdir))) {
      if (filePath.endsWith('.jsonl')) {
        redactJsonlFile(filePath, ctx);
      } else if (filePath.endsWith('.json')) {
        redactJsonFile(filePath, ctx);
      } else {
        redactPlainFile(filePath, ctx);
      }
    }
  }

  for (const filePath of walkDirFiles(join(opts.stagingDir, 'state'))) {
    const base = basename(filePath);
    if (STATE_JSON_FILES.has(base)) {
      redactJsonFile(filePath, ctx);
    } else {
      redactPlainFile(filePath, ctx);
    }
  }

  return { docNameMap: ctx.docNameMap, docNameCollisions: ctx.docNameCollisions };
}
