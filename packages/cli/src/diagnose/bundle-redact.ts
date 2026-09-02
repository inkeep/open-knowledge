import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CONTENT_DIR_TOKEN = '<CONTENT_DIR>';

export interface RedactStagedBundleOpts {
  stagingDir: string;
  contentDir: string;
}

interface RedactCtx {
  contentDir: string;
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
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    result[k] = redactValue(v, ctx);
  }
  return result;
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
    const replaced = replaceContentDir(content, ctx.contentDir);
    if (replaced !== content) writeFileSync(filePath, replaced);
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

const STATE_JSON_FILES = new Set(['agent-presence.json', 'agent-effects.json', 'runtime.json']);

export function isRotatedLogPath(filePath: string): boolean {
  return /\.log\.\d+$/.test(filePath);
}

function isLineDelimitedJson(filePath: string): boolean {
  return filePath.endsWith('.jsonl') || filePath.endsWith('.log') || isRotatedLogPath(filePath);
}

export const CONTENT_SUBDIRS_MASKED = [
  'telemetry',
  'logs',
  'process',
  'diagnostic-reports',
] as const;

export function redactStagedBundle(opts: RedactStagedBundleOpts): void {
  const ctx: RedactCtx = { contentDir: opts.contentDir };

  for (const subdir of CONTENT_SUBDIRS_MASKED) {
    for (const filePath of walkDirFiles(join(opts.stagingDir, subdir))) {
      if (isLineDelimitedJson(filePath)) {
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
    if (filePath.endsWith('.jsonl')) {
      redactJsonlFile(filePath, ctx);
    } else if (STATE_JSON_FILES.has(base)) {
      redactJsonFile(filePath, ctx);
    } else {
      redactPlainFile(filePath, ctx);
    }
  }
}
