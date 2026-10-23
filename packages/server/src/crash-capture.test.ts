import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SERVER_CRASH_LOG } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildCrashRecord,
  type CrashCaptureHandle,
  installCrashCapture,
  writeCrashArtifacts,
} from './crash-capture.ts';
import { logsCurrentPath } from './telemetry-file-sink.ts';

let fixtureDir: string;
let projectDir: string;
const handles: CrashCaptureHandle[] = [];

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'ok-crash-capture-'));
  projectDir = join(fixtureDir, 'project');
  await mkdir(projectDir);
  vi.stubEnv('HOME', join(fixtureDir, 'home'));
  vi.stubEnv('USERPROFILE', join(fixtureDir, 'home'));
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.uninstall();
  vi.unstubAllEnvs();
  await rm(fixtureDir, { recursive: true, force: true });
});

function emitMonitor(err: unknown, origin: string): void {
  (process as unknown as NodeJS.EventEmitter).emit('uncaughtExceptionMonitor', err, origin);
}

const crashJsonPath = () => join(projectDir, '.ok', 'local', SERVER_CRASH_LOG);
const logsPath = () => logsCurrentPath(projectDir);

describe('buildCrashRecord', () => {
  test('captures name, message, stack, pid, uptime from an Error', () => {
    const record = buildCrashRecord(new TypeError('boom'), 'uncaughtException');
    expect(record.origin).toBe('uncaughtException');
    expect(record.error.name).toBe('TypeError');
    expect(record.error.message).toBe('boom');
    expect(record.error.stack).toContain('boom');
    expect(record.pid).toBe(process.pid);
    expect(record.uptimeSec).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });

  test('normalizes a non-Error throw', () => {
    const record = buildCrashRecord('plain string reason', 'unhandledRejection');
    expect(record.origin).toBe('unhandledRejection');
    expect(record.error.name).toBe('NonError');
    expect(record.error.message).toBe('plain string reason');
    expect(record.error.stack).toBeNull();
  });
});

describe('writeCrashArtifacts', () => {
  test('writes last-server-crash.json and appends a fatal JSONL line to the log sink', () => {
    const record = buildCrashRecord(new Error('kaput'), 'uncaughtException');
    writeCrashArtifacts(projectDir, record);

    const crashJson = JSON.parse(readFileSync(crashJsonPath(), 'utf-8'));
    expect(crashJson.error.message).toBe('kaput');
    expect(crashJson.pid).toBe(process.pid);

    const lines = readFileSync(logsPath(), 'utf-8').trim().split('\n');
    if (process.platform !== 'win32')
      expect(statSync(dirname(logsPath())).mode & 0o777).toBe(0o700);
    expect(lines).toHaveLength(1);
    const logLine = JSON.parse(lines[0]);
    expect(logLine.level).toBe(60);
    expect(logLine.name).toBe('crash');
    expect(logLine.err.message).toBe('kaput');
    expect(logLine.msg).toContain('uncaughtException');
  });

  test('appends to an existing log sink file instead of truncating it', () => {
    mkdirSync(dirname(logsPath()), { recursive: true });
    writeFileSync(logsPath(), '{"level":30,"msg":"earlier"}\n');
    writeCrashArtifacts(projectDir, buildCrashRecord(new Error('later'), 'uncaughtException'));
    const lines = readFileSync(logsPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('earlier');
    expect(JSON.parse(lines[1]).err.message).toBe('later');
  });

  test('last-server-crash.json holds only the latest crash while the JSONL sink accumulates every one', () => {
    writeCrashArtifacts(projectDir, buildCrashRecord(new Error('root cause'), 'uncaughtException'));
    writeCrashArtifacts(
      projectDir,
      buildCrashRecord(new Error('restart symptom'), 'uncaughtException'),
    );

    const crashJson = JSON.parse(readFileSync(crashJsonPath(), 'utf-8'));
    expect(crashJson.error.message).toBe('restart symptom');

    const messages = readFileSync(logsPath(), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).err.message);
    expect(messages).toEqual(['root cause', 'restart symptom']);
  });

  test('swallows write failures instead of throwing', () => {
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'local'), 'not a directory');
    mkdirSync(dirname(dirname(logsPath())), { recursive: true });
    writeFileSync(dirname(logsPath()), 'not a directory');
    expect(() =>
      writeCrashArtifacts(projectDir, buildCrashRecord(new Error('x'), 'uncaughtException')),
    ).not.toThrow();
  });
});

describe('installCrashCapture', () => {
  test('monitor event writes artifacts for the registered project', () => {
    handles.push(installCrashCapture(projectDir));
    emitMonitor(new Error('monitored crash'), 'uncaughtException');
    expect(existsSync(crashJsonPath())).toBe(true);
    const record = JSON.parse(readFileSync(crashJsonPath(), 'utf-8'));
    expect(record.error.message).toBe('monitored crash');
    expect(existsSync(logsPath())).toBe(true);
  });

  test('records unhandled-rejection origin distinctly', () => {
    handles.push(installCrashCapture(projectDir));
    emitMonitor(new Error('rejected'), 'unhandledRejection');
    const record = JSON.parse(readFileSync(crashJsonPath(), 'utf-8'));
    expect(record.origin).toBe('unhandledRejection');
  });

  test('uninstall stops writes for that project', () => {
    const handle = installCrashCapture(projectDir);
    handle.uninstall();
    emitMonitor(new Error('after uninstall'), 'uncaughtException');
    expect(existsSync(crashJsonPath())).toBe(false);
  });

  test('refcounted: project stays registered until every install is uninstalled', () => {
    const first = installCrashCapture(projectDir);
    const second = installCrashCapture(projectDir);
    first.uninstall();
    emitMonitor(new Error('still armed'), 'uncaughtException');
    expect(existsSync(crashJsonPath())).toBe(true);
    second.uninstall();
  });

  test('uninstall is idempotent and does not over-decrement peers', () => {
    const first = installCrashCapture(projectDir);
    const second = installCrashCapture(projectDir);
    handles.push(second);
    first.uninstall();
    first.uninstall();
    emitMonitor(new Error('peer survives'), 'uncaughtException');
    expect(existsSync(crashJsonPath())).toBe(true);
  });
});
