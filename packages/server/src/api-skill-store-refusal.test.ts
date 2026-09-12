import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

let home: string;
let contentDir: string;

const globalSkillDir = (name: string): string => join(home, '.ok', 'skills', name);
const globalHostSkillDir = (name: string): string => join(home, '.agents', 'skills', name);
const projectSkillDir = (name: string): string => join(contentDir, '.ok', 'skills', name);
const markerPath = (base: string): string => join(base, '.ok', 'local', 'installed-skills.json');
const retentionPath = (base: string): string =>
  join(base, '.ok', 'local', 'skill-move-retained.json');
const lockPath = (base: string): string => join(base, '.ok', 'skills-lock.json');

const TRUNCATED_MARKER = '{"schema":1,"skills":{"trip-log":{"hosts":["cla';

function writeSkill(dir: string, name: string, body = 'hello'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
}

function seedFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function seedRetention(base: string, key: string, record: Record<string, unknown>): void {
  seedFile(
    retentionPath(base),
    `${JSON.stringify({ schema: 1, retained: { [key]: record } }, null, 2)}\n`,
  );
}

function retentionKeys(base: string): string[] {
  if (!existsSync(retentionPath(base))) return [];
  const parsed = JSON.parse(readFileSync(retentionPath(base), 'utf-8')) as {
    retained?: Record<string, unknown>;
  };
  return Object.keys(parsed.retained ?? {});
}

const retainedRecord = {
  retainedAt: '2026-01-01T00:00:00.000Z',
  from: 'project:trip-log',
  to: 'global:trip-log',
  sourceState: 'lossy',
  reason: 'UNLINK_FAILED',
  retainedContentHash: 'deadbeef',
};

function makeReq(method: string, url: string, body: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const readable = Readable.from(
    raw === '' ? [] : [Buffer.from(raw)],
  ) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: { status: number; raw: string } } {
  const captured = { status: 0, raw: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.raw = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function callApi(method: string, url: string, body?: unknown): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: { isDebounced: () => false, executeNow: async () => undefined },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    projectDir: contentDir,
    homeDirOverride: home,
    getFileIndex: () => new Map(),
  });
  const req = makeReq(method, url, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return {
    status: captured.status,
    body: captured.raw === '' ? {} : (JSON.parse(captured.raw) as Record<string, unknown>),
  };
}

const warningText = (body: Record<string, unknown>): string =>
  ((body.warnings as string[] | undefined) ?? []).join(' ');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-store-refusal-home-'));
  contentDir = mkdtempSync(join(tmpdir(), 'ok-store-refusal-proj-'));
  mkdirSync(join(home, '.agents'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(contentDir, { recursive: true, force: true });
});

describe('a bookkeeping refusal does not turn a completed skill delete into a 500', () => {
  test('the delete reports the deletion it performed and warns about the bookkeeping', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    seedFile(markerPath(home), TRUNCATED_MARKER);

    const res = await callApi('DELETE', '/api/skill?name=trip-log&scope=global');

    expect(res.status).toBe(200);
    expect(res.body.existed).toBe(true);
    expect(existsSync(globalSkillDir('trip-log'))).toBe(false);
    expect(warningText(res.body)).toContain('installed-skills.json');
  });

  test('the retry after a refusal converges instead of 500-ing forever', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    seedFile(markerPath(home), TRUNCATED_MARKER);

    await callApi('DELETE', '/api/skill?name=trip-log&scope=global');
    const retry = await callApi('DELETE', '/api/skill?name=trip-log&scope=global');

    expect(retry.status).toBe(200);
    expect(retry.body.existed).toBe(false);
  });

  test('the retained-destination record is still cleared when the marker refuses', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    seedRetention(home, 'global:trip-log', retainedRecord);
    seedFile(markerPath(home), TRUNCATED_MARKER);

    const res = await callApi('DELETE', '/api/skill?name=trip-log&scope=global');

    expect(res.status).toBe(200);
    expect(retentionKeys(home)).toEqual([]);
  });

  test('an unreadable marker reaches the caller as an errno, not as a parse failure', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    mkdirSync(markerPath(home), { recursive: true });

    const res = await callApi('DELETE', '/api/skill?name=trip-log&scope=global');

    expect(res.status).toBe(200);
    expect(warningText(res.body)).toContain('EISDIR');
  });
});

describe('a delete that could not read the directory it removed says so', () => {
  test('an unreadable occupant with a retained record reaches the caller as a hedged warning', async () => {
    const dir = globalSkillDir('trip-log');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'SKILL.md'), { recursive: true });
    seedRetention(home, 'global:trip-log', retainedRecord);

    const res = await callApi('DELETE', '/api/skill?name=trip-log&scope=global');

    expect(res.status).toBe(200);
    expect(warningText(res.body)).toContain('could not confirm');
  });
});

describe('a bookkeeping refusal does not turn a completed skill rename into a 500', () => {
  test('the rename reports the move it performed and warns about the bookkeeping', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    seedFile(markerPath(home), TRUNCATED_MARKER);

    const res = await callApi('POST', '/api/skill', {
      scope: 'global',
      fromName: 'trip-log',
      toName: 'travel-log',
    });

    expect(res.status).toBe(200);
    expect(existsSync(globalSkillDir('travel-log'))).toBe(true);
    expect(existsSync(globalSkillDir('trip-log'))).toBe(false);
    expect(warningText(res.body)).toContain('installed-skills.json');
  });

  test('a lock file that refuses to rewrite does not hide the rename either', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    seedFile(lockPath(home), '{"schema":1,"skills":{"trip-log":{"sour');

    const res = await callApi('POST', '/api/skill', {
      scope: 'global',
      fromName: 'trip-log',
      toName: 'travel-log',
    });

    expect(res.status).toBe(200);
    expect(existsSync(globalSkillDir('travel-log'))).toBe(true);
    expect(warningText(res.body)).toContain('skills-lock.json');
  });
});

describe('a bookkeeping refusal does not report a completed cross-scope move as partial', () => {
  test('the move reports success with a bookkeeping warning', async () => {
    writeSkill(projectSkillDir('trip-log'), 'trip-log');
    seedFile(markerPath(contentDir), TRUNCATED_MARKER);

    const res = await callApi('POST', '/api/skill/move-scope', {
      name: 'trip-log',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(res.status).toBe(200);
    expect(existsSync(globalHostSkillDir('trip-log'))).toBe(true);
    expect(existsSync(projectSkillDir('trip-log'))).toBe(false);
    expect(warningText(res.body)).toContain('installed-skills.json');
  });
});

describe('a bookkeeping refusal names the file the operator has to repair', () => {
  test('the uninstall failure detail names the refusing path', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    mkdirSync(markerPath(home), { recursive: true });

    const res = await callApi('POST', '/api/skill/uninstall', {
      name: 'trip-log',
      scope: 'global',
    });

    expect(res.status).toBe(500);
    expect(String(res.body.detail)).toContain('installed-skills.json');
  });
});

describe('a retained record beside a manifest-less directory is not described as unreadable', () => {
  test('the refusal does not claim the directory could not be read', async () => {
    writeSkill(projectSkillDir('trip-log'), 'trip-log');
    mkdirSync(globalHostSkillDir('trip-log'), { recursive: true });
    writeFileSync(join(globalHostSkillDir('trip-log'), 'notes.md'), 'kept\n');
    seedRetention(home, 'global:trip-log', retainedRecord);

    const res = await callApi('POST', '/api/skill/move-scope', {
      name: 'trip-log',
      fromScope: 'project',
      toScope: 'global',
    });

    expect(res.status).toBe(409);
    expect(String(res.body.detail)).not.toContain('could not read');
    expect(res.body.retentionLedger).toBe('occupant-unverifiable');
  });
});

describe('a within-level rename is not refused with cross-scope wording', () => {
  test('the collision detail names no operation the caller did not invoke', async () => {
    writeSkill(globalSkillDir('trip-log'), 'trip-log');
    mkdirSync(join(globalSkillDir('travel-log'), 'SKILL.md'), { recursive: true });

    const res = await callApi('POST', '/api/skill', {
      scope: 'global',
      fromName: 'trip-log',
      toName: 'travel-log',
    });

    expect(res.status).toBe(409);
    expect(String(res.body.detail)).toContain('could not read it');
    expect(String(res.body.detail)).not.toContain('cross-scope');
  });
});
