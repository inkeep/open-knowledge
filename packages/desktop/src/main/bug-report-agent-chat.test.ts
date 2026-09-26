import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type AgentChatStageOutcome,
  BARE_BASE64_MIN_LENGTH,
  defaultAgentChatThreadDirs,
  isAgentChatThreadId,
  OMITTED_EVENTS_KIND,
  stageAgentChatTranscript,
  TRUNCATED_EVENT_KIND,
} from './bug-report-agent-chat.ts';

const threadId = '0f5c0c0b-f439-4e49-84d6-6a6a97d675c6';
const token = `gho_${'a'.repeat(36)}`;
let dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-agent-chat-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const ndjson = (...events: unknown[]) =>
  events.map((event) => `${JSON.stringify(event)}\n`).join('');

function writeTranscript(dir: string, body: string): void {
  writeFileSync(join(dir, `${threadId}.ndjson`), body);
}

async function stageFrom(
  dir: string,
  options: { maxBytes?: number; tmpPaths?: string[] } = {},
): Promise<AgentChatStageOutcome> {
  return stageAgentChatTranscript({
    threadId,
    threadDirs: [dir],
    tmpDir: tmp(),
    tmpPaths: options.tmpPaths ?? [],
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });
}

function stagedFile(outcome: AgentChatStageOutcome, suffix: string) {
  if (outcome.status !== 'attached') throw new Error(`expected attached, got ${outcome.status}`);
  const file = outcome.files.find((f) => f.zipName?.endsWith(suffix));
  if (file === undefined) throw new Error(`no staged file ending ${suffix}`);
  return { ...file, text: readFileSync(file.sourcePath, 'utf8') };
}

describe('isAgentChatThreadId', () => {
  test('accepts chat ids and nothing that could name another file', () => {
    expect(isAgentChatThreadId(threadId)).toBe(true);
    for (const value of ['', '../x', `${threadId}/..`, `${threadId}.ndjson`, 42, null]) {
      expect(isAgentChatThreadId(value)).toBe(false);
    }
  });
});

describe('defaultAgentChatThreadDirs', () => {
  test("reads the store the server writes, then the project's legacy store", () => {
    const home = join(tmpdir(), 'home');
    const project = join(tmpdir(), 'project');
    expect(defaultAgentChatThreadDirs(project, home)).toEqual([
      join(home, '.ok', 'threads'),
      join(project, '.ok', 'local', 'threads'),
    ]);
    expect(defaultAgentChatThreadDirs(null, home)).toEqual([join(home, '.ok', 'threads')]);
  });
});

describe('stageAgentChatTranscript', () => {
  test('keeps the newest part of a long transcript, marked and starting at a whole line', async () => {
    const dir = tmp();
    const lines = Array.from({ length: 1000 }, (_, i) => `{"n":${i}}`);
    writeTranscript(dir, `${lines.join('\n')}\n`);
    const tmpPaths: string[] = [];

    const staged = await stageFrom(dir, { maxBytes: 100, tmpPaths });

    expect(staged.status === 'attached' && staged.truncated).toBe(true);
    expect(staged.status === 'attached' && staged.files.map((f) => f.zipName)).toEqual([
      `agent-chat/${threadId}.ndjson`,
    ]);
    const { text } = stagedFile(staged, '.ndjson');
    const [marker, oldestKept] = text.split('\n');
    expect(JSON.parse(marker ?? '')).toEqual({ kind: OMITTED_EVENTS_KIND });
    expect(oldestKept?.startsWith('{"n":')).toBe(true);
    expect(text.trimEnd().endsWith('{"n":999}')).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
    expect(tmpPaths).toHaveLength(1);
  });

  test('starts with a marker when earlier events are left out to fit the budget', async () => {
    const dir = tmp();
    const events = Array.from({ length: 20 }, (_, ts) => ({
      kind: 'agent_stderr',
      line: `line ${ts}`,
      ts,
    }));
    writeTranscript(dir, ndjson(...events));

    const staged = await stageFrom(dir, { maxBytes: 300 });
    const { text } = stagedFile(staged, '.ndjson');
    const [marker, ...kept] = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(staged.status === 'attached' && staged.truncated).toBe(true);
    expect(marker).toEqual({ kind: OMITTED_EVENTS_KIND });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(events.slice(-kept.length));
    expect(kept.length).toBeLessThan(events.length);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
  });

  test('leaves out a newest line the server has not finished writing', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      `${ndjson({ kind: 'turn_started', ts: 1 })}{"kind":"agent_stderr","line":"half-wri`,
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).toBe(ndjson({ kind: 'turn_started', ts: 1 }));
  });

  test('finds nothing when no directory holds the chat', async () => {
    const tmpPaths: string[] = [];
    expect(await stageFrom(tmp(), { tmpPaths })).toEqual({ status: 'not-found' });
    expect(tmpPaths).toEqual([]);
  });

  test('scrubs a token that starts a line of tool output', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson({ kind: 'agent_stderr', line: `$ gh auth token\n${token}\n`, ts: 1 }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    expect(JSON.parse(text).line).toBe('$ gh auth token\n[REDACTED-GH-PAT]\n');
  });

  test('scrubs a token right after a terminal color code and keeps the code', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson({ kind: 'agent_stderr', line: `\u001b[32m${token}\u001b[0m`, ts: 1 }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    expect(JSON.parse(text).line).toBe('\u001b[32m[REDACTED-GH-PAT]\u001b[0m');
  });

  test('scrubs a token right after any other terminal escape sequence', async () => {
    const dir = tmp();
    const sequences = ['\u001b[>4;2m', '\u001b(B', '\u001b7', '\u001b]0;title\u0007'];
    writeTranscript(
      dir,
      ndjson(
        ...sequences.map((sequence, ts) => ({
          kind: 'agent_stderr',
          line: `${sequence}${token}`,
          ts,
        })),
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    expect(
      text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).line),
    ).toEqual(sequences.map((sequence) => `${sequence}[REDACTED-GH-PAT]`));
  });

  test('scrubs a token inside JSON that a tool printed', async () => {
    const dir = tmp();
    const printed = JSON.stringify({ stdout: `ok\n${token}` });
    writeTranscript(
      dir,
      ndjson({
        kind: 'session_update',
        update: { content: [{ type: 'content', content: { type: 'text', text: printed } }] },
        ts: 1,
      }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    const inner = JSON.parse(JSON.parse(text).update.content[0].content.text);
    expect(inner).toEqual({ stdout: 'ok\n[REDACTED-GH-PAT]' });
  });

  test('keeps an Authorization header scrubbed when it is a key and value, not text', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson({
        kind: 'session_update',
        update: { rawInput: { headers: { Authorization: 'Bearer opaque-session-value' } } },
        ts: 1,
      }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain('opaque-session-value');
  });

  test('scrubs a line cut off mid-write instead of passing it through', async () => {
    const dir = tmp();
    writeTranscript(dir, `{"kind":"agent_stderr","line":"x\\n${token}\n`);

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED-GH-PAT]');
  });

  test('scrubs a line that is not JSON at all', async () => {
    const dir = tmp();
    writeTranscript(dir, `garbage ${token}\n`);

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).toBe('garbage [REDACTED-GH-PAT]\n');
  });

  test('replaces a private key block from its BEGIN line through its END line', async () => {
    const dir = tmp();
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'fake-key-body-line-one',
      'fake-key-body-line-two',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    writeTranscript(
      dir,
      ndjson({ kind: 'agent_stderr', line: `$ cat id_ed25519\n${key}\n$ ls`, ts: 1 }),
    );

    const { text, scrubbed } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain('fake-key-body');
    expect(JSON.parse(text).line).toBe('$ cat id_ed25519\n[REDACTED-PRIVATE-KEY]\n$ ls');
    expect(scrubbed).toEqual({ lineCount: 1, patterns: ['private-key'] });
  });

  test('replaces a private key body whose BEGIN line is not in the value through its END line', async () => {
    const dir = tmp();
    const tail = ['fake-key-body-line-two', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    const whole = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'fake-key-body-line-three',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    writeTranscript(
      dir,
      ndjson(
        { kind: 'agent_stderr', line: `${tail}\n$ ls\n${whole}\n$ pwd`, ts: 1 },
        { kind: 'agent_stderr', line: `${tail}\n${tail}\n$ ls`, ts: 2 },
      ),
    );

    const { text, scrubbed } = stagedFile(await stageFrom(dir), '.ndjson');
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).line);

    expect(text).not.toContain('fake-key-body');
    expect(lines).toEqual([
      '[REDACTED-PRIVATE-KEY]\n$ ls\n[REDACTED-PRIVATE-KEY]\n$ pwd',
      '[REDACTED-PRIVATE-KEY]\n$ ls',
    ]);
    expect(scrubbed).toEqual({ lineCount: 2, patterns: ['private-key'] });
  });

  test('replaces a private key block that stops before its END line through the end of the value', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson({
        kind: 'session_update',
        update: {
          rawOutput: {
            stdout: 'key:\n-----BEGIN RSA PRIVATE KEY-----\nfake-key-body-line-one\nfake-key-bo',
            exitCode: 0,
          },
        },
        ts: 1,
      }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain('fake-key-bo');
    expect(JSON.parse(text).update.rawOutput).toEqual({
      stdout: 'key:\n[REDACTED-PRIVATE-KEY]',
      exitCode: 0,
    });
  });

  test('replaces a JSON-escaped private key block on a line that is not valid JSON', async () => {
    const dir = tmp();
    const torn = `{"kind":"agent_stderr","line":"-----BEGIN PRIVATE KEY-----\\nfake-key-body-line-one\\n-----END PRIVATE KEY-----\\`;
    writeTranscript(dir, `${torn}{"kind":"turn_started","ts":2}\n`);

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain('fake-key-body');
    expect(text).toContain('[REDACTED-PRIVATE-KEY]');
  });

  test('replaces inline images and binary payloads with their type and size', async () => {
    const dir = tmp();
    const pasted = Buffer.alloc(3000, 1).toString('base64');
    const screenshot = Buffer.alloc(1200, 2).toString('base64');
    const pdf = Buffer.alloc(700, 3).toString('base64');
    const recording = Buffer.alloc(900, 4).toString('base64');
    writeTranscript(
      dir,
      ndjson(
        {
          kind: 'user_message',
          content: 'see attached',
          attachments: [
            { kind: 'image', data: pasted, mimeType: 'image/png', name: 'a.png', sizeBytes: 3000 },
            {
              kind: 'blob',
              data: `KEY=${token}`,
              textPayload: true,
              mimeType: 'text/plain',
              name: '.env',
            },
          ],
          ts: 1,
        },
        {
          kind: 'session_update',
          update: {
            content: [
              {
                type: 'content',
                content: { type: 'image', data: screenshot, mimeType: 'image/jpeg' },
              },
              {
                type: 'content',
                content: {
                  type: 'resource',
                  resource: { uri: 'file:///r.pdf', blob: pdf, mimeType: 'application/pdf' },
                },
              },
              {
                type: 'content',
                content: { type: 'audio', data: recording, mimeType: 'audio/wav' },
              },
            ],
          },
          ts: 2,
        },
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    for (const payload of [pasted, screenshot, pdf, recording]) {
      expect(text).not.toContain(payload);
    }
    expect(text).toContain('[omitted image/png, 3000 bytes]');
    expect(text).toContain('[omitted image/jpeg, 1200 bytes]');
    expect(text).toContain('[omitted application/pdf, 700 bytes]');
    expect(text).toContain('[omitted audio/wav, 900 bytes]');
    expect(text).toContain('KEY=[REDACTED-GH-PAT]');
  });

  test('attaches the transcript and metadata when the metadata was cut off mid-write', async () => {
    const dir = tmp();
    writeTranscript(dir, ndjson({ kind: 'turn_started', ts: 1 }));
    writeFileSync(
      join(dir, `${threadId}.meta.json`),
      `{"version":1,"agentRef":{"source":"registry","id":"codex-acp"},"info":{"title":"fix ${token}`,
    );

    const staged = await stageFrom(dir);

    if (staged.status !== 'attached') throw new Error(`expected attached, got ${staged.status}`);
    expect(stagedFile(staged, '.ndjson').text).toContain('turn_started');
    expect(staged.metadata).toEqual({ status: 'attached' });
    expect(stagedFile(staged, '.meta.json').text).not.toContain(token);
  });

  test('scrubs the chat metadata the same way and keeps its layout', async () => {
    const dir = tmp();
    writeTranscript(dir, ndjson({ kind: 'turn_started', ts: 1 }));
    const meta = { version: 1, info: { title: `fix\n${token}` }, cwd: '/Users/someone/project' };
    writeFileSync(join(dir, `${threadId}.meta.json`), `${JSON.stringify(meta, null, 1)}\n`);

    const staged = await stageFrom(dir);
    const { text, scrubbed, zipName } = stagedFile(staged, '.meta.json');

    expect(zipName).toBe(`agent-chat/${threadId}.meta.json`);
    expect(text).toBe(
      `${JSON.stringify({ ...meta, info: { title: 'fix\n[REDACTED-GH-PAT]' }, cwd: '~/project' }, null, 1)}\n`,
    );
    expect(scrubbed).toEqual({ lineCount: 2, patterns: ['github-pat', 'macos-home-path'] });
  });

  test('counts the metadata lines it scrubbed, not the secrets on them or the payloads it left out', async () => {
    const dir = tmp();
    writeTranscript(dir, ndjson({ kind: 'turn_started', ts: 1 }));
    const meta = {
      version: 1,
      info: {
        title: `retry "${token}" from /Users/someone/notes`,
        queue: [
          {
            id: 'q1',
            content: 'see the screenshot',
            attachments: [
              {
                kind: 'image',
                data: Buffer.alloc(300, 1).toString('base64'),
                mimeType: 'image/png',
                name: 'a.png',
              },
            ],
            ts: 2,
          },
        ],
      },
      cwd: '/Users/someone/project',
    };
    writeFileSync(join(dir, `${threadId}.meta.json`), `${JSON.stringify(meta, null, 1)}\n`);

    const { text, scrubbed } = stagedFile(await stageFrom(dir), '.meta.json');

    expect(text).toContain('[omitted image/png, 300 bytes]');
    expect(scrubbed).toEqual({ lineCount: 2, patterns: ['github-pat', 'macos-home-path'] });
  });

  test('keeps the transcript and reports metadata over the size limit as left out', async () => {
    const dir = tmp();
    writeTranscript(dir, ndjson({ kind: 'turn_started', ts: 1 }));
    const meta = `${JSON.stringify({ version: 1, info: { title: 'x'.repeat(300_000) } })}\n`;
    writeFileSync(join(dir, `${threadId}.meta.json`), meta);

    const staged = await stageFrom(dir);

    expect(staged).toMatchObject({
      status: 'attached',
      metadata: { status: 'too-large', sizeBytes: Buffer.byteLength(meta) },
    });
    expect(staged.status === 'attached' && staged.files.map((f) => f.zipName)).toEqual([
      `agent-chat/${threadId}.ndjson`,
    ]);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the transcript and reports why when the metadata cannot be read',
    async () => {
      const dir = tmp();
      writeTranscript(dir, ndjson({ kind: 'turn_started', ts: 1 }));
      const metaPath = join(dir, `${threadId}.meta.json`);
      writeFileSync(metaPath, '{"version":1}\n');
      chmodSync(metaPath, 0o000);

      const staged = await stageFrom(dir);

      expect(staged.status === 'attached' && staged.files.map((f) => f.zipName)).toEqual([
        `agent-chat/${threadId}.ndjson`,
      ]);
      expect(staged.status === 'attached' && staged.metadata).toMatchObject({
        status: 'failed',
        error: { code: 'EACCES' },
      });
    },
  );

  test('records what it scrubbed from the transcript for the bundle audit', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson(
        { kind: 'agent_stderr', line: `one ${token}`, ts: 1 },
        { kind: 'turn_started', ts: 2 },
        { kind: 'agent_stderr', line: `two\n${token}\n${token}`, ts: 3 },
      ),
    );

    const { scrubbed } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(scrubbed).toEqual({ lineCount: 2, patterns: ['github-pat'] });
  });

  test('a newest event larger than the budget still stages, cut short and marked', async () => {
    const dir = tmp();
    const newest = JSON.stringify({ kind: 'agent_stderr', line: 'x'.repeat(250), ts: 2 });
    writeTranscript(dir, `${JSON.stringify({ kind: 'turn_started', ts: 1 })}\n${newest}\n`);

    const staged = await stageFrom(dir, { maxBytes: 100 });
    const { text } = stagedFile(staged, '.ndjson');

    expect(staged.status === 'attached' && staged.truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
    const marker = JSON.parse(text.trimEnd().split('\n').at(-1) ?? '');
    expect(marker.kind).toBe(TRUNCATED_EVENT_KIND);
    expect(marker.bytes).toBe(Buffer.byteLength(newest));
    expect(marker.head.length).toBeGreaterThan(0);
    expect(newest.startsWith(marker.head)).toBe(true);
  });

  test('a newest event too large to read leaves the transcript out instead of staging it empty', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson(
        { kind: 'turn_started', ts: 1 },
        { kind: 'agent_stderr', line: 'x'.repeat(500), ts: 2 },
      ),
    );
    const tmpPaths: string[] = [];

    expect(await stageFrom(dir, { maxBytes: 100, tmpPaths })).toEqual({ status: 'too-large' });
    expect(tmpPaths).toEqual([]);
  });

  test('refuses a transcript or metadata file that is a symlink', async () => {
    const outside = join(tmp(), 'outside.txt');
    writeFileSync(outside, `${JSON.stringify({ kind: 'turn_started', ts: 1 })}\n`);
    const linked = tmp();
    symlinkSync(outside, join(linked, `${threadId}.ndjson`));
    expect(await stageFrom(linked)).toEqual({ status: 'not-found' });

    const metaLinked = tmp();
    writeTranscript(metaLinked, ndjson({ kind: 'turn_started', ts: 1 }));
    symlinkSync(outside, join(metaLinked, `${threadId}.meta.json`));
    const staged = await stageFrom(metaLinked);
    expect(staged.status === 'attached' && staged.files.map((f) => f.zipName)).toEqual([
      `agent-chat/${threadId}.ndjson`,
    ]);
    expect(staged.status === 'attached' && staged.metadata).toEqual({ status: 'not-found' });
  });

  test('treats something other than a file in place of the transcript as missing', async () => {
    const dir = tmp();
    mkdirSync(join(dir, `${threadId}.ndjson`));
    expect(await stageFrom(dir)).toEqual({ status: 'not-found' });
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a lookup that fails for any reason but a missing file is an error, not a missing chat',
    async () => {
      const locked = join(tmp(), 'locked');
      mkdirSync(locked);
      writeTranscript(locked, ndjson({ kind: 'turn_started', ts: 1 }));
      chmodSync(locked, 0o000);
      try {
        await expect(stageFrom(locked)).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe('stageAgentChatTranscript on text streamed across events', () => {
  const chunk = (sessionUpdate: string, messageId: string, text: string, ts: number) => ({
    kind: 'session_update',
    update: { sessionUpdate, messageId, content: { type: 'text', text } },
    ts,
  });
  const body = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw';

  test('redacts a private key whose block was streamed over several events', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson(
        chunk('agent_message_chunk', 'm1', 'Here it is:\n-----BEGIN RSA PRIVATE ', 1),
        chunk('agent_message_chunk', 'm1', `KEY-----\n${body}\n`, 2),
        chunk('agent_message_chunk', 'm1', `${body}\n-----END RSA PRIVATE KEY-----\nDone.`, 3),
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(body.slice(0, 20));
    expect(text).not.toContain('PRIVATE KEY-----');
    expect(text).toContain('[REDACTED-PRIVATE-KEY]');
    expect(text).toContain('Here it is:');
    expect(text).toContain('Done.');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  test('redacts a private key cut off mid-stream through the end of what was streamed', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson(
        chunk('agent_thought_chunk', 't1', '-----BEGIN PRIVATE KEY-----\n', 1),
        chunk('agent_thought_chunk', 't1', `${body}\n${body}`, 2),
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(body.slice(0, 20));
  });

  test('redacts keys split between events of one message or one terminal', async () => {
    const dir = tmp();
    const openai = `sk-${'a'.repeat(30)}`;
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    writeTranscript(
      dir,
      ndjson(
        chunk('agent_thought_chunk', 't1', `key ${openai.slice(0, 12)}`, 1),
        chunk('agent_thought_chunk', 't1', `${openai.slice(12)} done`, 2),
        {
          kind: 'terminal_output',
          terminalId: 'term-1',
          chunk: `export KEY=${aws.slice(0, 9)}`,
          ts: 3,
        },
        { kind: 'terminal_output', terminalId: 'term-1', chunk: `${aws.slice(9)}\n`, ts: 4 },
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(openai.slice(0, 12));
    expect(text).not.toContain(aws.slice(0, 9));
    expect(text).toContain('[REDACTED-OPENAI]');
    expect(text).toContain('[REDACTED-AWS-KEY]');
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  test('keeps events of different messages and terminals apart', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson(
        chunk('agent_message_chunk', 'm1', 'first', 1),
        chunk('agent_message_chunk', 'm2', 'second', 2),
        { kind: 'terminal_output', terminalId: 'term-1', chunk: 'one', ts: 3 },
        { kind: 'terminal_output', terminalId: 'term-2', chunk: 'two', ts: 4 },
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text.trim().split('\n')).toHaveLength(4);
  });

  test('keeps when each part of a joined line arrived', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson(
        chunk('agent_message_chunk', 'm1', 'one ', 1),
        chunk('agent_message_chunk', 'm1', 'two ', 2),
        chunk('agent_message_chunk', 'm1', 'three', 120_001),
        chunk('agent_message_chunk', 'm2', 'alone', 120_002),
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');
    const [joined, alone] = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(joined.update.content.text).toBe('one two three');
    expect(joined.ts).toBe(1);
    expect(joined.chunkTs).toEqual([1, 2, 120_001]);
    expect(alone).toEqual(chunk('agent_message_chunk', 'm2', 'alone', 120_002));
  });

  test('keeps a Codex warning apart from the reply streamed after it', async () => {
    const unmarked = (text: string, ts: number) => ({
      kind: 'session_update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      ts,
    });
    const lineCounts: number[] = [];
    for (const id of ['codex-acp', 'claude-acp']) {
      const dir = tmp();
      writeFileSync(
        join(dir, `${threadId}.meta.json`),
        JSON.stringify({ version: 1, agentRef: { source: 'registry', id } }),
      );
      writeTranscript(dir, ndjson(unmarked('Warning: stale config\n\n', 1), unmarked('Hi', 2)));
      const { text } = stagedFile(await stageFrom(dir), '.ndjson');
      lineCounts.push(text.trim().split('\n').length);
    }

    expect(lineCounts).toEqual([2, 1]);
  });
});

describe('stageAgentChatTranscript on awkward layouts', () => {
  test('scrubs long runs of escaped quotes and backslashes in linear time', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      `${JSON.stringify({ kind: 'user_message', content: '\\"'.repeat(150_000), ts: 1 })}\n${JSON.stringify({ kind: 'agent_stderr', line: `${'\\'.repeat(300_000)}x`, ts: 2 })}\n{"kind":"agent_stderr","line":"x${'\\\\\\"'.repeat(75_000)}\n`,
    );

    const started = performance.now();
    const staged = await stageFrom(dir);

    expect(performance.now() - started).toBeLessThan(2000);
    expect(staged.status).toBe('attached');
  });

  test('scans for private key blocks and near-threshold base64 runs in linear time', async () => {
    const dir = tmp();
    const nearlyBase64 = `${'A'.repeat(BARE_BASE64_MIN_LENGTH - 1)} `.repeat(500);
    const keyMarkers = `${'-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----'.repeat(20_000)}-----BEGIN PRIVATE KEY-----${'y'.repeat(100_000)}`;
    writeTranscript(
      dir,
      ndjson(
        { kind: 'agent_stderr', line: nearlyBase64, ts: 1 },
        { kind: 'agent_stderr', line: keyMarkers, ts: 2 },
      ),
    );

    const started = performance.now();
    const staged = await stageFrom(dir);

    expect(performance.now() - started).toBeLessThan(2000);
    const [runs, keys] = stagedFile(staged, '.ndjson')
      .text.trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).line);
    expect(runs).toBe(nearlyBase64);
    expect(keys).toBe('[REDACTED-PRIVATE-KEY]'.repeat(20_001));
  });

  test.each([
    [
      'inside JSON nested three levels deep',
      JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ out: `x\n${token}` }) }) }),
    ],
    ['in a Python repr', `CompletedProcess(returncode=0, stdout='Logged in\\n${token}\\n')`],
    ['in a JSON literal that was cut off', `{"output":"line one\\n${token}`],
  ])('scrubs a token right after an escaped newline %s', async (_layout, line) => {
    const dir = tmp();
    writeTranscript(dir, ndjson({ kind: 'agent_stderr', line, ts: 1 }));

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED-GH-PAT]');
  });

  test('still shortens a Windows home path whose user name starts like an escape', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson({ kind: 'agent_stderr', line: 'opened C:\\Users\\nancy\\notes.txt', ts: 1 }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(JSON.parse(text).line).toBe('opened ~\\notes.txt');
  });

  test('replaces base64 image data wherever it appears', async () => {
    const dir = tmp();
    const png = Buffer.alloc(6000, 7).toString('base64');
    const jpeg = Buffer.alloc(900, 8).toString('base64');
    const bare = Buffer.alloc(5000, 9).toString('base64');
    writeTranscript(
      dir,
      ndjson(
        {
          kind: 'session_update',
          update: {
            rawOutput: {
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
              ],
            },
          },
          ts: 1,
        },
        {
          kind: 'session_update',
          update: {
            rawInput: {
              html: `<p>logo</p><img src="data:image/jpeg;base64,${jpeg}"> done`,
              icon: `data:image/jpeg;base64,${jpeg}`,
            },
          },
          ts: 2,
        },
        { kind: 'session_update', update: { rawOutput: { screenshot: bare } }, ts: 3 },
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    for (const payload of [png, jpeg, bare]) expect(text).not.toContain(payload);
    const [anthropic, dataUrls, screenshot] = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line).update);
    expect(anthropic.rawOutput.content[0].source.data).toBe('[omitted image/png, 6000 bytes]');
    expect(dataUrls.rawInput).toEqual({
      html: '<p>logo</p><img src="[omitted image/jpeg, 900 bytes]"> done',
      icon: '[omitted image/jpeg, 900 bytes]',
    });
    expect(screenshot.rawOutput.screenshot).toBe('[omitted base64 data, 5000 bytes]');
  });
});

describe('stageAgentChatTranscript on undecoded escapes and payload edges', () => {
  test.each([
    [
      'an escaped color code in JSON nested three levels deep',
      JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ out: `\u001b[32m${token}` }) }) }),
    ],
    [
      'an escaped color code in a nested literal cut off by the length cap',
      `{"output":"${'x'.repeat(15_900)}\\u001b[32m${token}`,
    ],
    ['an escaped color code in a Python repr', `CompletedProcess(stdout='\\x1b[32m${token}')`],
    ['a form feed escape', `CompletedProcess(stdout='page\\f${token}')`],
    ['a hex newline escape', `b'line\\x0a${token}'`],
    ['a percent-encoded newline', `https://example.test/callback?next=%0A${token}`],
    ['a color code whose escape byte was stripped', `[32m${token}[0m`],
    ['a color code in caret notation', `^[[32m${token}`],
    ['an 8-bit control sequence', `\u009b32m${token}`],
    ['an HTML-encoded escape byte', `&#x1b;[32m${token}`],
  ])('scrubs a token right after %s', async (_layout, line) => {
    const dir = tmp();
    writeTranscript(dir, ndjson({ kind: 'agent_stderr', line, ts: 1 }));

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED-GH-PAT]');
  });

  test('scrubs OpenAI project keys and Stripe live keys after a control sequence whose escape byte was stripped', async () => {
    const dir = tmp();
    const openai = `sk-proj-${'a'.repeat(24)}`;
    const stripe = `sk_live_${'b'.repeat(24)}`;
    const restricted = `rk_live_${'c'.repeat(24)}`;
    writeTranscript(
      dir,
      ndjson(
        { kind: 'agent_stderr', line: `[32m${openai}[0m`, ts: 1 },
        { kind: 'agent_stderr', line: `\u009b32m${stripe}`, ts: 2 },
        { kind: 'agent_stderr', line: `[2K[1G${restricted}`, ts: 3 },
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(openai);
    expect(text).not.toContain(stripe);
    expect(text).not.toContain(restricted);
    expect(text.trim().split('\n')).toHaveLength(3);
  });

  test('omits base64 data inside JSON that a tool printed as text, even with its slashes escaped', async () => {
    const dir = tmp();
    const png = Buffer.alloc(6000, 5).toString('base64');
    const icon = Buffer.alloc(6000, 0xff).toString('base64');
    const printed = JSON.stringify({
      screenshot: png,
      icon: `data:image/png;base64,${icon}`,
      ok: true,
    }).replaceAll('/', '\\/');
    writeTranscript(
      dir,
      ndjson({
        kind: 'session_update',
        update: { content: [{ type: 'content', content: { type: 'text', text: printed } }] },
        ts: 1,
      }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(png);
    expect(JSON.parse(JSON.parse(text).update.content[0].content.text)).toEqual({
      screenshot: '[omitted base64 data, 6000 bytes]',
      icon: '[omitted image/png, 6000 bytes]',
      ok: true,
    });
  });

  test('omits base64 data on a line that is not valid JSON', async () => {
    const dir = tmp();
    const cut = Buffer.alloc(6000, 6).toString('base64').slice(0, 5000);
    const printed = Buffer.alloc(4500, 7).toString('base64');
    writeTranscript(
      dir,
      `{"kind":"session_update","update":{"rawOutput":{"screenshot":"${cut}{"kind":"turn_ended","ts":2}\nscreenshot saved: ${printed}\n`,
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(text).not.toContain(cut);
    expect(text).not.toContain(printed);
    expect(text).toContain('"screenshot":"[omitted base64 data, 3750 bytes]{"');
    expect(text).toContain('screenshot saved: [omitted base64 data, 4500 bytes]');
  });

  test('keeps the text around a leading data URL and counts only its payload', async () => {
    const dir = tmp();
    writeTranscript(
      dir,
      ndjson({
        kind: 'agent_stderr',
        line: 'data:text/plain;base64,aGVsbG8= then here is my note',
        ts: 1,
      }),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');

    expect(JSON.parse(text).line).toBe('[omitted text/plain, 5 bytes] then here is my note');
  });

  test('omits bare base64 from the threshold up, and never inside a text payload', async () => {
    const dir = tmp();
    const below = 'A'.repeat(BARE_BASE64_MIN_LENGTH - 1);
    const at = 'A'.repeat(BARE_BASE64_MIN_LENGTH);
    const textFile = 'A'.repeat(5000);
    writeTranscript(
      dir,
      ndjson(
        { kind: 'agent_stderr', line: below, ts: 1 },
        { kind: 'agent_stderr', line: at, ts: 2 },
        {
          kind: 'user_message',
          content: 'see the attached file',
          attachments: [
            {
              kind: 'blob',
              data: textFile,
              textPayload: true,
              mimeType: 'text/plain',
              name: 'a.txt',
            },
          ],
          ts: 3,
        },
      ),
    );

    const { text } = stagedFile(await stageFrom(dir), '.ndjson');
    const [first, second, third] = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(first.line).toBe(below);
    expect(second.line).toBe(`[omitted base64 data, ${Buffer.byteLength(at, 'base64')} bytes]`);
    expect(third.attachments[0].data).toBe(textFile);
  });
});
