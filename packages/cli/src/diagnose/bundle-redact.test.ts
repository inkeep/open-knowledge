import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { redactStagedBundle } from './bundle-redact.ts';

const tmpDirs: string[] = [];

function makeStagingDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-redact-test-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'telemetry'));
  mkdirSync(join(dir, 'logs'));
  mkdirSync(join(dir, 'state'));
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function writeStaged(stagingDir: string, relPath: string, body: string): void {
  writeFileSync(join(stagingDir, relPath), body);
}

function readStaged(stagingDir: string, relPath: string): string {
  return readFileSync(join(stagingDir, relPath), 'utf-8');
}

describe('redactStagedBundle — doc names ship raw', () => {
  test('leaves an OTLP `doc.name` attribute value unhashed', () => {
    const stagingDir = makeStagingDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { attributes: [{ key: 'doc.name', value: { stringValue: 'meetings/plan' } }] },
              ],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '/Users/test/notes' });

    const after = readStaged(stagingDir, 'telemetry/spans-current.jsonl');
    expect(after).toContain('meetings/plan');
    expect(after).not.toMatch(/doc:[a-f0-9]{8}/);
  });

  test('leaves a Pino flat-key `doc.name` and a presence `currentDoc` raw', () => {
    const stagingDir = makeStagingDir();
    const pinoLine = JSON.stringify({ level: 30, 'doc.name': 'notes/journal', msg: 'wrote doc' });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);
    writeStaged(
      stagingDir,
      'state/agent-presence.json',
      JSON.stringify({
        presence: { 'agent-a1': { currentDoc: 'meetings/secret-standup', ts: 1 } },
      }),
    );

    redactStagedBundle({ stagingDir, contentDir: '/Users/test/notes' });

    expect(JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim())['doc.name']).toBe(
      'notes/journal',
    );
    expect(
      JSON.parse(readStaged(stagingDir, 'state/agent-presence.json')).presence['agent-a1']
        .currentDoc,
    ).toBe('meetings/secret-standup');
  });
});

describe('redactStagedBundle — contentDir masking', () => {
  test('replaces the contentDir prefix in an OTLP string-value attribute', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/my-notes';
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [{ key: 'fs.path', value: { stringValue: `${contentDir}/foo.md` } }],
                },
              ],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'telemetry/spans-current.jsonl');
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>/foo.md');
  });

  test('replaces every occurrence of contentDir in a single string field', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const pinoLine = JSON.stringify({
      level: 30,
      msg: `opened ${contentDir}/a then ${contentDir}/b`,
    });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir });

    expect(JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim()).msg).toBe(
      'opened <CONTENT_DIR>/a then <CONTENT_DIR>/b',
    );
  });

  test('masks contentDir in state/runtime.json via the JSON walker', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    writeStaged(
      stagingDir,
      'state/runtime.json',
      `${JSON.stringify({ ok: { workingDir: contentDir } }, null, 2)}\n`,
    );

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'state/runtime.json');
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>');
  });

  test('masks contentDir in a diagnostic-reports/*.ips without re-serialising it', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    mkdirSync(join(stagingDir, 'diagnostic-reports'));
    const header = JSON.stringify({ app_name: 'OpenKnowledge', name: 'OpenKnowledge' });
    const body = [
      '{',
      `  "procPath" : "${contentDir}/OpenKnowledge.app/Contents/MacOS/OpenKnowledge",`,
      `  "asi" : {"OpenKnowledge":["loaded from ${contentDir}/plugins"]},`,
      '  "threads" : [{"threadState":{"x":[{"value":18446744072631617535}]}}],',
      '  "termination" : {"namespace":"SIGNAL","indicator":"Abort trap: 6"}',
      '}',
    ].join('\n');
    const raw = `${header}\n${body}\n`;
    writeStaged(stagingDir, 'diagnostic-reports/OpenKnowledge-2026-08-27.ips', raw);

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'diagnostic-reports/OpenKnowledge-2026-08-27.ips');
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>/OpenKnowledge.app/Contents/MacOS/OpenKnowledge');
    expect(after).toContain('loaded from <CONTENT_DIR>/plugins');
    expect(after).toContain('"value":18446744072631617535');
    expect(after).toContain('"termination" : {');
  });

  test('leaves an .ips alone when the content dir does not appear in it', () => {
    const stagingDir = makeStagingDir();
    mkdirSync(join(stagingDir, 'diagnostic-reports'));
    const raw = `{"name":"OpenKnowledge"}\n{"threads":[{"x":[{"value":18446744072631617535}]}]}\n`;
    writeStaged(stagingDir, 'diagnostic-reports/OpenKnowledge-clean.ips', raw);

    redactStagedBundle({ stagingDir, contentDir: '/Users/nobody/no-such-dir' });

    expect(readStaged(stagingDir, 'diagnostic-reports/OpenKnowledge-clean.ips')).toBe(raw);
  });

  test('masks a truncated .ips that will not parse', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    mkdirSync(join(stagingDir, 'diagnostic-reports'));
    writeStaged(
      stagingDir,
      'diagnostic-reports/OpenKnowledge-truncated.ips',
      `{"name":"OpenKnowledge"}\n{"procPath":"${contentDir}/bin`,
    );

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'diagnostic-reports/OpenKnowledge-truncated.ips');
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>/bin');
  });

  test('masks contentDir in a state/.txt plain file', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    writeStaged(
      stagingDir,
      'state/shadow-head.txt',
      `deadbee ${contentDir}/foo\nbabecake ${contentDir}/bar\n`,
    );

    redactStagedBundle({ stagingDir, contentDir });

    expect(readStaged(stagingDir, 'state/shadow-head.txt')).toBe(
      'deadbee <CONTENT_DIR>/foo\nbabecake <CONTENT_DIR>/bar\n',
    );
  });

  test('masks contentDir in state/watcher-recent.jsonl line-by-line', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const lines = [
      JSON.stringify({
        ts: 1,
        decision: 'dispatched',
        absPath: `${contentDir}/meetings/standup.md`,
      }),
      JSON.stringify({
        ts: 2,
        decision: 'drop-filter-excluded',
        absPath: `${contentDir}/dist/o.md`,
      }),
    ];
    writeStaged(stagingDir, 'state/watcher-recent.jsonl', `${lines.join('\n')}\n`);

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'state/watcher-recent.jsonl');
    expect(after).not.toContain(contentDir);
    const parsed = after
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(parsed[0].absPath).toBe('<CONTENT_DIR>/meetings/standup.md');
    expect(parsed[0].decision).toBe('dispatched');
  });

  test('preserves a partial trailing JSONL line untouched (SIGKILL resilience)', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const complete = JSON.stringify({ msg: `at ${contentDir}/a` });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${complete}\n${complete}\n{"msg"`);

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'telemetry/spans-current.jsonl');
    expect(after.endsWith('{"msg"')).toBe(true);
    expect(after).not.toContain(`${contentDir}/a`);
    expect(after).toContain('<CONTENT_DIR>/a');
  });

  test('masks contentDir in a corrupt (unparseable) state JSON via the whole-file fallback', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const torn = `{ "active-doc": "notes/plan", "contentDir": "${contentDir}", /* corrupt`;
    writeStaged(stagingDir, 'state/agent-presence.json', torn);

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'state/agent-presence.json');
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>');
    expect(after).toContain('notes/plan');
  });

  test('non-string leaves pass through unchanged', () => {
    const stagingDir = makeStagingDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ attributes: [{ key: 'http.status_code', value: { intValue: 200 } }] }] },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '/x' });

    const after = JSON.parse(readStaged(stagingDir, 'telemetry/spans-current.jsonl').trim());
    expect(after.resourceSpans[0].scopeSpans[0].spans[0].attributes[0]).toEqual({
      key: 'http.status_code',
      value: { intValue: 200 },
    });
  });

  test('a string with no contentDir substring is passed through verbatim', () => {
    const stagingDir = makeStagingDir();
    const pinoLine = JSON.stringify({ level: 30, msg: 'unrelated message' });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '/Users/test/notes' });

    expect(JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim()).msg).toBe(
      'unrelated message',
    );
  });

  test('an empty contentDir does not insert tokens between characters', () => {
    const stagingDir = makeStagingDir();
    const pinoLine = JSON.stringify({ level: 30, msg: 'abc' });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '' });

    expect(JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim()).msg).toBe('abc');
  });

  test('empty staging dir is a no-op', () => {
    const stagingDir = makeStagingDir();
    expect(() => redactStagedBundle({ stagingDir, contentDir: '/x' })).not.toThrow();
  });
});

describe('redactStagedBundle — process/ subdirectory', () => {
  test('masks the content-dir prefix in process/metadata.json', () => {
    const stagingDir = makeStagingDir();
    mkdirSync(join(stagingDir, 'process'));
    const contentDir = '/Users/jane/secret-vault';
    writeStaged(
      stagingDir,
      'process/metadata.json',
      JSON.stringify({ worktreeRoot: contentDir, pid: 12345 }),
    );

    redactStagedBundle({ stagingDir, contentDir });

    const after = JSON.parse(readStaged(stagingDir, 'process/metadata.json'));
    expect(after.worktreeRoot).toBe('<CONTENT_DIR>');
    expect(after.pid).toBe(12345);
  });

  test('masks the content-dir prefix in process/lsof.txt', () => {
    const stagingDir = makeStagingDir();
    mkdirSync(join(stagingDir, 'process'));
    const contentDir = '/Users/jane/secret-vault';
    writeStaged(
      stagingDir,
      'process/lsof.txt',
      `node 1234 jane cwd DIR ${contentDir}\nnode 1234 jane txt REG /usr/bin/node\n`,
    );

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'process/lsof.txt');
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>');
    expect(after).toContain('/usr/bin/node');
  });
});

describe('redactStagedBundle — cross-platform basename dispatch', () => {
  test('stdlib pin: node:path.win32.basename strips backslash-joined Windows paths to the file name', async () => {
    const { posix, win32 } = await import('node:path');
    expect(win32.basename('C:\\stage\\state\\runtime.json')).toBe('runtime.json');
    expect(posix.basename('/Users/jane/stage/state/runtime.json')).toBe('runtime.json');
    expect(win32.basename('/Users/jane/stage/state/runtime.json')).toBe('runtime.json');
  });
});
