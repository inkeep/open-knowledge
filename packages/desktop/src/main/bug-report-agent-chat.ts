import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BundleExtraFile } from '@inkeep/open-knowledge';
import { BUG_REPORT_AGENT_CHAT_ZIP_DIR, OK_DIR, redactSecrets } from '@inkeep/open-knowledge-core';
import type { CodexLegacyAgentIdentity } from '@inkeep/open-knowledge-core/acp/codex-legacy-notice';
import {
  acpThreadStoreRoots,
  acpThreadsDir,
  getLocalDir,
  isMintedThreadId,
  streamedChunkOf,
} from '@inkeep/open-knowledge-server';

const AGENT_CHAT_TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;

const AGENT_CHAT_READ_WINDOW_FACTOR = 4;

const AGENT_CHAT_META_MAX_BYTES = 256 * 1024;

const AGENT_CHAT_META_INDENT = 1;

const NESTED_JSON_MAX_DEPTH = 2;

export const TRUNCATED_EVENT_KIND = 'bug_report_truncated_event';

export const OMITTED_EVENTS_KIND = 'bug_report_omitted_events';

const OMITTED_EVENTS_LINE = JSON.stringify({ kind: OMITTED_EVENTS_KIND });

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC and BEL bytes are what this splits on
const ANSI_ESCAPE = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~])/;

const UNDECODED_ESCAPE =
  /((?<!\\)\\+(?:(?:u001[bB]|x1[bB]|033|e)\[[0-?]*[ -/]*[@-~]|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[0-3][0-7]{2}|[0-7]{1,2}|[A-Za-z0-9_])|%[0-9A-Fa-f]{2})/;

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;

const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;

const PRIVATE_KEY_PATTERN = 'private-key';

const MIME_TYPE = /^[\w.+-]{1,100}\/[\w.+-]{1,100}$/;

const DATA_URL_RUN =
  /data:([\w.+-]{1,100}\/[\w.+-]{1,100})(?:;[\w.+-]{1,100}=[\w.+-]{1,100})*;base64,([A-Za-z0-9+/]+={0,2})/g;

export const BARE_BASE64_MIN_LENGTH = 4096;

const BARE_BASE64_RUN = new RegExp(
  `(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{${BARE_BASE64_MIN_LENGTH},}={0,2}`,
  'g',
);

export function isAgentChatThreadId(value: unknown): value is string {
  return typeof value === 'string' && isMintedThreadId(value);
}

export function defaultAgentChatThreadDirs(
  projectDir: string | null,
  home: string = homedir(),
): string[] {
  return acpThreadStoreRoots(
    join(home, OK_DIR),
    projectDir === null ? null : getLocalDir(projectDir),
  ).map((root) => acpThreadsDir(root));
}

interface ScrubTally {
  readonly patterns: Set<string>;
  readonly redacting: boolean;
  redactions: number;
  omittedPayloads: number;
}

function newTally(): ScrubTally {
  return { patterns: new Set(), redacting: true, redactions: 0, omittedPayloads: 0 };
}

function redactPrivateKeyBlocks(text: string, tally: ScrubTally): string {
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let begin = PRIVATE_KEY_BEGIN.exec(text);
  const firstBegin = begin === null ? text.length : begin.index;
  let copied = 0;
  PRIVATE_KEY_END.lastIndex = 0;
  let headlessEnd = PRIVATE_KEY_END.exec(text);
  while (headlessEnd !== null && headlessEnd.index < firstBegin) {
    copied = PRIVATE_KEY_END.lastIndex;
    headlessEnd = PRIVATE_KEY_END.exec(text);
  }
  if (begin === null && copied === 0) return text;
  const pieces: string[] = copied === 0 ? [] : ['[REDACTED-PRIVATE-KEY]'];
  while (begin !== null) {
    pieces.push(text.slice(copied, begin.index), '[REDACTED-PRIVATE-KEY]');
    PRIVATE_KEY_END.lastIndex = PRIVATE_KEY_BEGIN.lastIndex;
    const end = PRIVATE_KEY_END.exec(text);
    copied = end === null ? text.length : PRIVATE_KEY_END.lastIndex;
    PRIVATE_KEY_BEGIN.lastIndex = copied;
    begin = end === null ? null : PRIVATE_KEY_BEGIN.exec(text);
  }
  pieces.push(text.slice(copied));
  tally.patterns.add(PRIVATE_KEY_PATTERN);
  return pieces.join('');
}

function redactBetweenSeparators(parts: string[], tally: ScrubTally): void {
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index] ?? '';
    const result = redactSecrets(part);
    if (result.redacted === part) continue;
    for (const pattern of result.patterns) tally.patterns.add(pattern);
    parts[index] = result.redacted;
  }
}

function scrubPlainText(text: string, tally: ScrubTally): string {
  if (!tally.redacting) return text;
  const aroundAnsi = redactPrivateKeyBlocks(text, tally).split(ANSI_ESCAPE);
  redactBetweenSeparators(aroundAnsi, tally);
  const aroundEscapes = aroundAnsi.join('').split(UNDECODED_ESCAPE);
  redactBetweenSeparators(aroundEscapes, tally);
  const scrubbed = aroundEscapes.join('');
  if (scrubbed !== text) tally.redactions += 1;
  return scrubbed;
}

function scrubLiteral(
  body: string,
  closed: boolean,
  tally: ScrubTally,
  depth: number,
  markedAsText: boolean,
): string | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(`"${body}"`);
  } catch {
    return null;
  }
  if (typeof decoded !== 'string') return null;
  const scrubbed = scrubString(decoded, tally, depth, markedAsText);
  if (scrubbed === decoded) return null;
  const encoded = JSON.stringify(scrubbed);
  return closed ? encoded : encoded.slice(0, -1);
}

function replaceStringLiterals(
  text: string,
  includeUnclosed: boolean,
  replace: (body: string, closed: boolean) => string | null,
): string {
  const pieces: string[] = [];
  let copiedUpTo = 0;
  let open = text.indexOf('"');
  while (open !== -1) {
    let cursor = open + 1;
    while (cursor < text.length && text[cursor] !== '"') {
      cursor += text[cursor] === '\\' ? 2 : 1;
    }
    const closed = cursor < text.length;
    if (!closed && !includeUnclosed) break;
    const bodyEnd = cursor > text.length ? text.length - 1 : cursor;
    const end = closed ? cursor + 1 : text.length;
    const replacement = replace(text.slice(open + 1, bodyEnd), closed);
    if (replacement !== null) {
      pieces.push(text.slice(copiedUpTo, open), replacement);
      copiedUpTo = end;
    }
    if (!closed) break;
    open = text.indexOf('"', end);
  }
  if (pieces.length === 0) return text;
  pieces.push(text.slice(copiedUpTo));
  return pieces.join('');
}

function scrubString(
  value: string,
  tally: ScrubTally,
  depth: number,
  markedAsText: boolean,
): string {
  const withoutPayloads = omitInlinePayloads(value, tally, markedAsText);
  const withLiterals =
    depth < NESTED_JSON_MAX_DEPTH
      ? replaceStringLiterals(withoutPayloads, false, (body) =>
          scrubLiteral(body, true, tally, depth + 1, markedAsText),
        )
      : withoutPayloads;
  return scrubPlainText(withLiterals, tally);
}

function omitEmbeddedDataUrls(text: string, tally: ScrubTally): string {
  return text.replace(DATA_URL_RUN, (_run: string, mimeType: string, payload: string) => {
    tally.omittedPayloads += 1;
    return `[omitted ${mimeType}, ${Buffer.byteLength(payload, 'base64')} bytes]`;
  });
}

function omitInlinePayloads(value: string, tally: ScrubTally, markedAsText: boolean): string {
  const withoutDataUrls = omitEmbeddedDataUrls(value, tally);
  if (markedAsText) return withoutDataUrls;
  return withoutDataUrls.replace(BARE_BASE64_RUN, (run: string) => {
    tally.omittedPayloads += 1;
    return `[omitted base64 data, ${Buffer.byteLength(run, 'base64')} bytes]`;
  });
}

function inlinePayloadKey(node: Record<string, unknown>): 'data' | 'blob' | null {
  if (typeof node.data === 'string') {
    if (node.type === 'image' || node.type === 'audio' || node.kind === 'image') return 'data';
    if (node.type === 'base64') return 'data';
    if (node.kind === 'blob' && node.textPayload !== true) return 'data';
  }
  if (typeof node.blob === 'string' && typeof node.uri === 'string') return 'blob';
  return null;
}

function payloadPlaceholder(node: Record<string, unknown>, payload: string): string {
  const declaredType = typeof node.mimeType === 'string' ? node.mimeType : node.media_type;
  const mimeType =
    typeof declaredType === 'string' && MIME_TYPE.test(declaredType)
      ? declaredType
      : 'unknown type';
  const bytes =
    typeof node.sizeBytes === 'number' &&
    Number.isSafeInteger(node.sizeBytes) &&
    node.sizeBytes >= 0
      ? node.sizeBytes
      : Buffer.byteLength(payload, 'base64');
  return `[omitted ${mimeType}, ${bytes} bytes]`;
}

function scrubNode(node: unknown, tally: ScrubTally, markedAsText = false): unknown {
  if (typeof node === 'string') return scrubString(node, tally, 0, markedAsText);
  if (Array.isArray(node)) return node.map((item) => scrubNode(item, tally, markedAsText));
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  const payloadKey = inlinePayloadKey(record);
  const childrenMarkedAsText = markedAsText || record.textPayload === true;
  const scrubbed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    if (key === payloadKey && typeof value === 'string') {
      scrubbed[key] = payloadPlaceholder(record, value);
      tally.omittedPayloads += 1;
    } else {
      scrubbed[key] = scrubNode(value, tally, childrenMarkedAsText);
    }
  }
  return scrubbed;
}

function scrubJsonText(text: string, tally: ScrubTally, indent?: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const withLiterals = replaceStringLiterals(text, true, (body, closed) =>
      scrubLiteral(body, closed, tally, 0, false),
    );
    return scrubPlainText(omitInlinePayloads(withLiterals, tally, false), tally);
  }
  const mutationsBefore = tally.redactions + tally.omittedPayloads;
  const scrubbed = scrubNode(parsed, tally);
  const serialized =
    tally.redactions + tally.omittedPayloads === mutationsBefore
      ? text
      : `${JSON.stringify(scrubbed, null, indent)}${text.slice(text.trimEnd().length)}`;
  return scrubPlainText(serialized, tally);
}

function cutEventLine(line: string, maxBytes: number): string {
  const bytes = Buffer.from(line, 'utf8');
  for (let headBytes = Math.floor(maxBytes / 4); ; headBytes = Math.floor(headBytes / 2)) {
    const marker = JSON.stringify({
      kind: TRUNCATED_EVENT_KIND,
      bytes: bytes.length,
      head: bytes.subarray(0, headBytes).toString('utf8'),
    });
    if (Buffer.byteLength(marker) < maxBytes || headBytes === 0) return marker;
  }
}

interface TailWindow {
  readonly text: string;
  readonly fromStart: boolean;
}

interface ScrubbedTranscript {
  readonly text: string;
  readonly truncated: boolean;
  readonly redactedLines: number;
  readonly patterns: readonly string[];
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withJoinedText(event: Record<string, unknown>, text: string): Record<string, unknown> {
  if (event.kind === 'terminal_output') return { ...event, chunk: text };
  const update = objectOf(event.update);
  return { ...event, update: { ...update, content: { ...objectOf(update?.content), text } } };
}

function joinStreamedLines(
  lines: readonly string[],
  agent: CodexLegacyAgentIdentity | null,
): string[] {
  const joined: string[] = [];
  let run: {
    stream: string;
    first: Record<string, unknown>;
    line: string;
    parts: string[];
    times: unknown[];
  } | null = null;
  const closeRun = (): void => {
    if (run === null) return;
    joined.push(
      run.parts.length === 1
        ? run.line
        : JSON.stringify({ ...withJoinedText(run.first, run.parts.join('')), chunkTs: run.times }),
    );
    run = null;
  };
  for (const line of lines) {
    let event: Record<string, unknown> | null = null;
    try {
      event = objectOf(JSON.parse(line));
    } catch {}
    const chunk = event === null ? null : streamedChunkOf(event, agent);
    if (event !== null && chunk !== null && run !== null && run.stream === chunk.stream) {
      run.parts.push(chunk.text);
      run.times.push(event.ts ?? null);
      continue;
    }
    closeRun();
    if (event === null || chunk === null) joined.push(line);
    else {
      run = {
        stream: chunk.stream,
        first: event,
        line,
        parts: [chunk.text],
        times: [event.ts ?? null],
      };
    }
  }
  closeRun();
  return joined;
}

function scrubTranscript(
  window: TailWindow,
  maxBytes: number,
  agent: CodexLegacyAgentIdentity | null,
): ScrubbedTranscript | null {
  const windowLines = window.text.split('\n');
  windowLines.pop();
  if (!window.fromStart) {
    if (windowLines.length <= 1) return null;
    windowLines.shift();
  }
  const lines = joinStreamedLines(windowLines, agent);
  const markerBytes = Buffer.byteLength(OMITTED_EVENTS_LINE) + 1;
  const kept: string[] = [];
  const patterns = new Set<string>();
  let used = 0;
  let redactedLines = 0;
  let cut = false;
  let omittedEarlier = !window.fromStart;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const budget = index > 0 || !window.fromStart ? maxBytes - markerBytes : maxBytes;
    const tally = newTally();
    let line = scrubJsonText(lines[index] ?? '', tally);
    if (used + Buffer.byteLength(line) + 1 > budget) {
      if (kept.length > 0) {
        omittedEarlier = true;
        break;
      }
      cut = true;
      line = cutEventLine(line, budget);
    }
    kept.push(line);
    used += Buffer.byteLength(line) + 1;
    if (tally.redactions > 0) redactedLines += 1;
    for (const pattern of tally.patterns) patterns.add(pattern);
  }
  if (omittedEarlier) kept.push(OMITTED_EVENTS_LINE);
  kept.reverse();
  return {
    text: kept.length === 0 ? '' : `${kept.join('\n')}\n`,
    truncated: omittedEarlier || cut,
    redactedLines,
    patterns: [...patterns],
  };
}

interface OpenedFile {
  readonly handle: FileHandle;
  readonly size: number;
}

async function openRegularFile(path: string): Promise<OpenedFile | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw err;
  }
  try {
    const info = await handle.stat();
    if (info.isFile()) return { handle, size: info.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
  await handle.close();
  return null;
}

async function readTail(file: OpenedFile, maxBytes: number): Promise<TailWindow> {
  const start = Math.max(0, file.size - maxBytes);
  const buffer = Buffer.alloc(file.size - start);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await file.handle.read(
      buffer,
      filled,
      buffer.length - filled,
      start + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return { text: buffer.subarray(0, filled).toString('utf8'), fromStart: start === 0 };
}

type MetadataRead =
  | { readonly status: 'read'; readonly text: string }
  | { readonly status: 'not-found' }
  | { readonly status: 'too-large'; readonly sizeBytes: number };

async function readMetadata(path: string): Promise<MetadataRead> {
  const file = await openRegularFile(path);
  if (file === null) return { status: 'not-found' };
  try {
    if (file.size > AGENT_CHAT_META_MAX_BYTES) return { status: 'too-large', sizeBytes: file.size };
    return { status: 'read', text: (await readTail(file, AGENT_CHAT_META_MAX_BYTES)).text };
  } finally {
    await file.handle.close();
  }
}

async function readAgentRef(path: string): Promise<CodexLegacyAgentIdentity | null> {
  try {
    const read = await readMetadata(path);
    if (read.status !== 'read') return null;
    const ref = objectOf(objectOf(JSON.parse(read.text))?.agentRef);
    const source = ref?.source;
    return (source === 'registry' || source === 'custom') && typeof ref?.id === 'string'
      ? { source, id: ref.id }
      : null;
  } catch {
    return null;
  }
}

function countChangedLines(before: string, after: string): number {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let changed = 0;
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    if (beforeLines[index] !== afterLines[index]) changed += 1;
  }
  return changed;
}

export type AgentChatMetadataOutcome =
  | { readonly status: 'attached' }
  | { readonly status: 'not-found' }
  | { readonly status: 'too-large'; readonly sizeBytes: number }
  | { readonly status: 'failed'; readonly error: unknown };

export type AgentChatStageOutcome =
  | {
      readonly status: 'attached';
      readonly files: readonly BundleExtraFile[];
      readonly truncated: boolean;
      readonly metadata: AgentChatMetadataOutcome;
    }
  | { readonly status: 'not-found' }
  | { readonly status: 'too-large' };

export async function stageAgentChatTranscript(opts: {
  threadId: string;
  threadDirs: readonly string[];
  tmpDir: string;
  tmpPaths: string[];
  maxBytes?: number;
}): Promise<AgentChatStageOutcome> {
  const maxBytes = opts.maxBytes ?? AGENT_CHAT_TRANSCRIPT_MAX_BYTES;
  const files: BundleExtraFile[] = [];
  const stage = async (
    name: string,
    text: string,
    scrubbed: BundleExtraFile['scrubbed'],
  ): Promise<void> => {
    const sourcePath = join(opts.tmpDir, `ok-bugreport-agent-chat-${randomUUID()}-${name}`);
    opts.tmpPaths.push(sourcePath);
    await writeFile(sourcePath, text, { mode: 0o600 });
    files.push({ sourcePath, zipName: `${BUG_REPORT_AGENT_CHAT_ZIP_DIR}/${name}`, scrubbed });
  };
  const stageMetadata = async (dir: string): Promise<AgentChatMetadataOutcome> => {
    const read = await readMetadata(join(dir, `${opts.threadId}.meta.json`));
    if (read.status !== 'read') return read;
    const tally = newTally();
    const text = scrubJsonText(read.text, tally, AGENT_CHAT_META_INDENT);
    const unredacted = scrubJsonText(
      read.text,
      { ...newTally(), redacting: false },
      AGENT_CHAT_META_INDENT,
    );
    await stage(`${opts.threadId}.meta.json`, text, {
      lineCount: countChangedLines(unredacted, text),
      patterns: [...tally.patterns],
    });
    return { status: 'attached' };
  };
  let lookupError: unknown = null;
  for (const dir of opts.threadDirs) {
    let events: OpenedFile | null;
    try {
      events = await openRegularFile(join(dir, `${opts.threadId}.ndjson`));
    } catch (err) {
      lookupError ??= err;
      continue;
    }
    if (events === null) continue;
    let window: TailWindow;
    try {
      window = await readTail(events, maxBytes * AGENT_CHAT_READ_WINDOW_FACTOR);
    } finally {
      await events.handle.close();
    }
    const transcript = scrubTranscript(
      window,
      maxBytes,
      await readAgentRef(join(dir, `${opts.threadId}.meta.json`)),
    );
    if (transcript === null) return { status: 'too-large' };
    await stage(`${opts.threadId}.ndjson`, transcript.text, {
      lineCount: transcript.redactedLines,
      patterns: [...transcript.patterns],
    });
    const metadata = await stageMetadata(dir).catch(
      (error: unknown): AgentChatMetadataOutcome => ({ status: 'failed', error }),
    );
    return { status: 'attached', files, truncated: transcript.truncated, metadata };
  }
  if (lookupError !== null) throw lookupError;
  return { status: 'not-found' };
}
