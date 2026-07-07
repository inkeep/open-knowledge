/**
 * Unit tests for the bundle redactor.
 *
 * The redactor walks staged JSONL + JSON files under a bundle's staging dir
 * and produces:
 *   - doc.name attribute values replaced by `doc:<8 hex>` BLAKE2b-256 hashes
 *   - the absolute content-dir prefix replaced with the literal `<CONTENT_DIR>`
 *   - a stable per-bundle inverse map (`hashed → original`) for `manifest.json`
 *
 * Tests use real disk fixtures (no fs mocks) since the module's job is
 * filesystem-shaped. We seed JSONL + JSON in a tmpdir, call the redactor,
 * and assert on the rewritten files + the returned map.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _recordHashForTests,
  type RedactStagedBundleResult,
  redactStagedBundle,
} from './bundle-redact.ts';

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

// ---------------------------------------------------------------------------
// OTLP attribute-pair shape gets doc.name hashed
// ---------------------------------------------------------------------------

describe('redactStagedBundle — tracer bullet', () => {
  test('hashes the OTLP attribute-pair `doc.name` stringValue', () => {
    const stagingDir = makeStagingDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [{ key: 'doc.name', value: { stringValue: 'my-secret-doc' } }],
                },
              ],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    const result = redactStagedBundle({ stagingDir, contentDir: '/Users/test/notes' });

    const after = readStaged(stagingDir, 'telemetry/spans-current.jsonl');
    expect(after).not.toContain('my-secret-doc');
    expect(after).toMatch(/"doc:[a-f0-9]{8}"/);

    // The inverse map records hashed → original.
    const entries = Object.entries(result.docNameMap);
    expect(entries).toHaveLength(1);
    const [hashed, original] = entries[0] ?? ['', ''];
    expect(original).toBe('my-secret-doc');
    expect(hashed).toMatch(/^doc:[a-f0-9]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Pino flat-key shape + nested objects
// ---------------------------------------------------------------------------

describe('redactStagedBundle — Pino + nested shapes', () => {
  test('hashes a Pino flat-key `doc.name` value in a log record', () => {
    const stagingDir = makeStagingDir();
    const pinoLine = JSON.stringify({
      level: 30,
      time: 1716908521000,
      'doc.name': 'pino-secret',
      msg: 'wrote doc',
    });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    const result = redactStagedBundle({ stagingDir, contentDir: '/Users/test/notes' });

    const after = readStaged(stagingDir, 'logs/server-current.jsonl');
    expect(after).not.toContain('pino-secret');
    const parsed = JSON.parse(after.trim());
    expect(parsed['doc.name']).toMatch(/^doc:[a-f0-9]{8}$/);
    expect(Object.values(result.docNameMap)).toContain('pino-secret');
  });

  test('hashes a `doc.name` nested inside a structured Pino log object', () => {
    const stagingDir = makeStagingDir();
    const pinoLine = JSON.stringify({
      level: 30,
      msg: 'handler',
      req: { url: '/api/x', 'doc.name': 'nested-doc' },
    });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '/x' });

    const after = JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim());
    expect(after.req['doc.name']).toMatch(/^doc:[a-f0-9]{8}$/);
    expect(after.req['doc.name']).not.toBe('nested-doc');
  });

  test('preserves non-doc-name attributes inside an OTLP attribute array', () => {
    const stagingDir = makeStagingDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    { key: 'http.method', value: { stringValue: 'GET' } },
                    { key: 'doc.name', value: { stringValue: 'secret-x' } },
                    { key: 'http.status_code', value: { intValue: 200 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '/Users/test/notes' });

    const after = JSON.parse(readStaged(stagingDir, 'telemetry/spans-current.jsonl').trim());
    const attrs = after.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attrs[0]).toEqual({ key: 'http.method', value: { stringValue: 'GET' } });
    expect(attrs[1].key).toBe('doc.name');
    expect(attrs[1].value.stringValue).toMatch(/^doc:[a-f0-9]{8}$/);
    expect(attrs[2]).toEqual({ key: 'http.status_code', value: { intValue: 200 } });
  });

  test('walks doc.name in resource-level and event-level OTLP attributes too', () => {
    const stagingDir = makeStagingDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'doc.name', value: { stringValue: 'res-doc' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  events: [
                    {
                      attributes: [{ key: 'doc.name', value: { stringValue: 'evt-doc' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    const result = redactStagedBundle({ stagingDir, contentDir: '/x' });

    const after = readStaged(stagingDir, 'telemetry/spans-current.jsonl');
    expect(after).not.toContain('res-doc');
    expect(after).not.toContain('evt-doc');
    expect(Object.values(result.docNameMap).sort()).toEqual(['evt-doc', 'res-doc']);
  });

  test('preserves the partial trailing line untouched (AC8 SIGKILL resilience)', () => {
    const stagingDir = makeStagingDir();
    const completeLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ attributes: [{ key: 'doc.name', value: { stringValue: 'a' } }] }] },
          ],
        },
      ],
    });
    // Two complete lines + one unterminated trailing fragment (mid-write).
    const body = `${completeLine}\n${completeLine}\n{"resourceSpans"`;
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', body);

    redactStagedBundle({ stagingDir, contentDir: '/x' });

    const after = readStaged(stagingDir, 'telemetry/spans-current.jsonl');
    // Trailing fragment preserved verbatim — recipients skip it the same way.
    expect(after.endsWith('{"resourceSpans"')).toBe(true);
    // Both complete lines were redacted.
    expect(after).not.toContain('"a"');
  });

  test('non-string doc.name values pass through unchanged (only strings hash)', () => {
    // A doc.name attribute with an intValue (theoretically possible) should
    // NOT be hashed. The redactor only touches stringValue/string forms.
    const stagingDir = makeStagingDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [{ key: 'doc.name', value: { intValue: 12345 } }],
                },
              ],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    const result = redactStagedBundle({ stagingDir, contentDir: '/x' });

    const after = JSON.parse(readStaged(stagingDir, 'telemetry/spans-current.jsonl').trim());
    expect(after.resourceSpans[0].scopeSpans[0].spans[0].attributes[0]).toEqual({
      key: 'doc.name',
      value: { intValue: 12345 },
    });
    expect(result.docNameMap).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// contentDir → <CONTENT_DIR> substring substitution
// ---------------------------------------------------------------------------

describe('redactStagedBundle — contentDir substitution', () => {
  test('replaces contentDir prefix in span string-value attributes', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/my-notes';
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    {
                      key: 'fs.path',
                      value: { stringValue: '/Users/test/my-notes/foo.md' },
                    },
                  ],
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
    expect(after).not.toContain('/Users/test/my-notes');
    expect(after).toContain('<CONTENT_DIR>/foo.md');
  });

  test('replaces all occurrences of contentDir in a single string field', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const pinoLine = JSON.stringify({
      level: 30,
      msg: 'opened /Users/test/notes/a then /Users/test/notes/b',
    });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir });

    const after = JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim());
    expect(after.msg).toBe('opened <CONTENT_DIR>/a then <CONTENT_DIR>/b');
  });

  test('replaces contentDir in state/runtime.json string fields', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    writeStaged(
      stagingDir,
      'state/runtime.json',
      `${JSON.stringify({ ok: { workingDir: '/Users/test/notes' } }, null, 2)}\n`,
    );

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'state/runtime.json');
    expect(after).not.toContain('/Users/test/notes');
    expect(after).toContain('<CONTENT_DIR>');
  });

  test('replaces contentDir in state/.txt plain files (substring only)', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    writeStaged(
      stagingDir,
      'state/shadow-head.txt',
      'deadbee /Users/test/notes/foo\nbabecake /Users/test/notes/bar\n',
    );

    redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'state/shadow-head.txt');
    expect(after).toBe('deadbee <CONTENT_DIR>/foo\nbabecake <CONTENT_DIR>/bar\n');
  });

  test('replaces contentDir in state/agent-presence.json walker pass', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    writeStaged(
      stagingDir,
      'state/agent-presence.json',
      `${JSON.stringify({
        agents: [
          {
            agentId: 'a1',
            'doc.name': 'live-doc',
            workingDir: '/Users/test/notes',
          },
        ],
      })}`,
    );

    const result = redactStagedBundle({ stagingDir, contentDir });

    const after = JSON.parse(readStaged(stagingDir, 'state/agent-presence.json'));
    expect(after.agents[0].workingDir).toBe('<CONTENT_DIR>');
    expect(after.agents[0]['doc.name']).toMatch(/^doc:[a-f0-9]{8}$/);
    expect(Object.values(result.docNameMap)).toContain('live-doc');
  });

  test('strings that do not include contentDir are passed through verbatim', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const pinoLine = JSON.stringify({ level: 30, msg: 'unrelated message' });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir });

    const after = JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim());
    expect(after.msg).toBe('unrelated message');
  });

  test('stable per-bundle: same input → same hash; map has one entry', () => {
    const stagingDir = makeStagingDir();
    const sharedLine = JSON.stringify({
      'doc.name': 'same',
      msg: 'one',
    });
    const sharedLine2 = JSON.stringify({
      'doc.name': 'same',
      msg: 'two',
    });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${sharedLine}\n${sharedLine2}\n`);

    const result = redactStagedBundle({ stagingDir, contentDir: '/x' });

    const after = readStaged(stagingDir, 'logs/server-current.jsonl').trim().split('\n');
    const p1 = JSON.parse(after[0] ?? '');
    const p2 = JSON.parse(after[1] ?? '');
    expect(p1['doc.name']).toBe(p2['doc.name']);
    expect(Object.keys(result.docNameMap)).toHaveLength(1);
  });

  test('distinct doc names produce distinct hashes and map entries', () => {
    const stagingDir = makeStagingDir();
    const a = JSON.stringify({ 'doc.name': 'a' });
    const b = JSON.stringify({ 'doc.name': 'b' });
    const c = JSON.stringify({ 'doc.name': 'c' });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${a}\n${b}\n${c}\n`);

    const result = redactStagedBundle({ stagingDir, contentDir: '/x' });
    expect(Object.keys(result.docNameMap)).toHaveLength(3);
    expect(Object.values(result.docNameMap).sort()).toEqual(['a', 'b', 'c']);
    // Hashes are deterministic but distinct.
    const hashes = Object.keys(result.docNameMap);
    expect(new Set(hashes).size).toBe(3);
  });

  test('empty staging dir produces an empty docNameMap', () => {
    const stagingDir = makeStagingDir();
    const result = redactStagedBundle({ stagingDir, contentDir: '/x' });
    expect(result.docNameMap).toEqual({});
  });

  test('empty contentDir does not insert tokens between characters', () => {
    // Defensive guard against a degenerate config that hands the redactor an
    // empty string. Without the guard, split('').join('<CONTENT_DIR>') would
    // explode every string into per-character tokens.
    const stagingDir = makeStagingDir();
    const pinoLine = JSON.stringify({ level: 30, msg: 'abc' });
    writeStaged(stagingDir, 'logs/server-current.jsonl', `${pinoLine}\n`);

    redactStagedBundle({ stagingDir, contentDir: '' });

    const after = JSON.parse(readStaged(stagingDir, 'logs/server-current.jsonl').trim());
    expect(after.msg).toBe('abc');
  });
});

describe('hashOrLookup — collision detection', () => {
  test('first occurrence of a hash claims the inverse-map entry; subsequent distinct collisions go to docNameCollisions', () => {
    // We exercise the internal recordHash helper directly because finding
    // two distinct doc names that produce the same BLAKE2b-256 8-hex prefix
    // is infeasible. The unit test pins the *behavior* a real collision
    // would trigger — first value wins the docNameMap slot; later distinct
    // colliding values are surfaced separately so the user does not silently
    // lose one original from the inverse map.
    const ctx = {
      contentDir: '/tmp/c',
      docNameMap: {} as Record<string, string>,
      originalToHashed: new Map<string, string>(),
      docNameCollisions: {} as Record<string, string[]>,
    };
    _recordHashForTests(ctx, 'first-value', 'collide');
    _recordHashForTests(ctx, 'second-value', 'collide');
    _recordHashForTests(ctx, 'third-value', 'collide');
    // Repeat shouldn't double-record.
    _recordHashForTests(ctx, 'second-value', 'collide');
    expect(ctx.docNameMap.collide).toBe('first-value');
    expect(ctx.docNameCollisions.collide).toEqual(['second-value', 'third-value']);
  });

  test('repeated record of the same value is a no-op (idempotent)', () => {
    const ctx = {
      contentDir: '/tmp/c',
      docNameMap: {} as Record<string, string>,
      originalToHashed: new Map<string, string>(),
      docNameCollisions: {} as Record<string, string[]>,
    };
    _recordHashForTests(ctx, 'value', 'h');
    _recordHashForTests(ctx, 'value', 'h');
    expect(ctx.docNameMap.h).toBe('value');
    expect(ctx.docNameCollisions).toEqual({});
  });

  test('RedactStagedBundleResult surfaces an empty docNameCollisions when nothing collides', () => {
    // No collision-free workspace should pay for collision tracking; the
    // field is present on the result type so consumers can rely on it,
    // but should be an empty object when no real collision occurred.
    const stagingDir = mkdtempSync(resolve(tmpdir(), 'ok-redact-collision-'));
    tmpDirs.push(stagingDir);
    mkdirSync(join(stagingDir, 'telemetry'));
    mkdirSync(join(stagingDir, 'logs'));
    mkdirSync(join(stagingDir, 'state'));
    writeFileSync(
      join(stagingDir, 'telemetry', 'spans-current.jsonl'),
      `${JSON.stringify({ 'doc.name': 'unique-doc' })}\n`,
    );
    const result: RedactStagedBundleResult = redactStagedBundle({
      stagingDir,
      contentDir: '/nonexistent',
    });
    expect(result.docNameCollisions).toEqual({});
  });
});

describe('redactStagedBundle — process/ subdirectory', () => {
  test('strips content-dir prefix from process/metadata.json', () => {
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

  test('strips content-dir prefix from process/lsof.txt', () => {
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

  test('hashes doc.name values inside process/*.jsonl files', () => {
    const stagingDir = makeStagingDir();
    mkdirSync(join(stagingDir, 'process'));
    const line = JSON.stringify({ 'doc.name': 'sensitive-folder/note' });
    writeStaged(stagingDir, 'process/process-stats.jsonl', `${line}\n`);

    redactStagedBundle({ stagingDir, contentDir: '/no-match' });

    const after = readStaged(stagingDir, 'process/process-stats.jsonl').trim();
    const parsed = JSON.parse(after);
    expect(parsed['doc.name']).toMatch(/^doc:[0-9a-f]{8}$/);
  });

  test('substring-scrubs doc names from a corrupt state/agent-presence.json under --redact', () => {
    const stagingDir = makeStagingDir();
    const contentDir = '/Users/test/notes';
    const secretDoc = 'private-folder/auth-doc';

    // Telemetry walked FIRST populates ctx.originalToHashed via the
    // OTLP attribute-pair walker, so the substring scrub knows what
    // literal to look for once the JSON walker hits the corrupt state.
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [{ attributes: [{ key: 'doc.name', value: { stringValue: secretDoc } }] }],
            },
          ],
        },
      ],
    });
    writeStaged(stagingDir, 'telemetry/spans-current.jsonl', `${otlpLine}\n`);

    const torn = `{ "active-doc": "${secretDoc}", "contentDir": "${contentDir}", "uptimeMs": 12345, /* corrupt`;
    writeStaged(stagingDir, 'state/agent-presence.json', torn);

    const result = redactStagedBundle({ stagingDir, contentDir });

    const after = readStaged(stagingDir, 'state/agent-presence.json');
    expect(after).not.toContain(secretDoc);
    expect(after).not.toContain(contentDir);
    expect(after).toContain('<CONTENT_DIR>');
    expect(after).toMatch(/doc:[0-9a-f]{8}/);
    expect(Object.values(result.docNameMap)).toContain(secretDoc);
  });
});

describe('redactStagedBundle — cross-platform basename dispatch', () => {
  test('stdlib pin: node:path.win32.basename strips backslash-joined Windows paths to the file name', async () => {
    // Stdlib documentation pin — NOT an end-to-end test of the production
    // dispatch through redactStagedBundle. The production dispatch (with
    // POSIX paths) is covered by the "replaces contentDir in state/
    // agent-presence.json walker pass" test above and the corrupt-
    // state-file test in the process/ describe block; both call
    // redactStagedBundle and assert the JSON walker route fires (doc.name
    // hashed). The Windows leg of the dispatch can't be exercised from a
    // macOS host (Node's default `import { basename } from 'node:path'`
    // resolves to path.posix.basename at runtime; only path.win32.basename
    // honors backslashes regardless of host), so this test pins the
    // stdlib contract the production fix relies on — when Node runs on
    // Windows, the same `import { basename }` resolves to path.win32.basename
    // and the dispatch routes correctly.
    const { posix, win32 } = await import('node:path');
    expect(win32.basename('C:\\Users\\jane\\stage\\state\\agent-presence.json')).toBe(
      'agent-presence.json',
    );
    expect(win32.basename('C:\\stage\\state\\runtime.json')).toBe('runtime.json');
    // POSIX path is unchanged on both variants (no regression).
    expect(posix.basename('/Users/jane/stage/state/agent-presence.json')).toBe(
      'agent-presence.json',
    );
    expect(win32.basename('/Users/jane/stage/state/agent-presence.json')).toBe(
      'agent-presence.json',
    );
  });
});
