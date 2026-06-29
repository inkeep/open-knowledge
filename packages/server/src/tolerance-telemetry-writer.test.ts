import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { emitToleranceFire } from '@inkeep/open-knowledge-core';

import {
  initToleranceTelemetryWriter,
  isToleranceTelemetryEnabled,
  teardownToleranceTelemetryWriter,
} from './tolerance-telemetry-writer.ts';

let tmpProjectDir: string;

beforeEach(() => {
  tmpProjectDir = resolve(tmpdir(), `ok-telemetry-test-${randomUUID()}`);
  mkdirSync(tmpProjectDir, { recursive: true });
  delete process.env.OK_BRIDGE_TOLERANCE_TELEMETRY;
});

afterEach(async () => {
  await teardownToleranceTelemetryWriter();
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {}
});

describe('isToleranceTelemetryEnabled', () => {
  test('returns false by default', () => {
    expect(isToleranceTelemetryEnabled({})).toBe(false);
  });

  test('returns true when OK_BRIDGE_TOLERANCE_TELEMETRY=1', () => {
    expect(isToleranceTelemetryEnabled({ OK_BRIDGE_TOLERANCE_TELEMETRY: '1' })).toBe(true);
  });

  test('returns false for other values', () => {
    expect(isToleranceTelemetryEnabled({ OK_BRIDGE_TOLERANCE_TELEMETRY: '0' })).toBe(false);
    expect(isToleranceTelemetryEnabled({ OK_BRIDGE_TOLERANCE_TELEMETRY: 'true' })).toBe(false);
  });
});

describe('initToleranceTelemetryWriter', () => {
  test('does nothing when flag is OFF', () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '0';
    initToleranceTelemetryWriter(tmpProjectDir);

    emitToleranceFire(['crlf'], 'a\r\n', 'a\n', 'test-doc');

    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    expect(existsSync(logPath)).toBe(false);
  });

  test('writes JSONL when flag is ON', async () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    initToleranceTelemetryWriter(tmpProjectDir);

    emitToleranceFire(['crlf'], 'a\r\n', 'a\n', 'notes/meeting');

    await teardownToleranceTelemetryWriter();
    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0] ?? '');
    expect(record.event).toBe('bridge-tolerance-fire');
    expect(record.class).toBe('crlf');
    expect(record.document).toBe('notes/meeting');
    expect(record.codeUnitPosition).toBe(1);
    expect(record.severity).toBe('parser-caused');
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('appends multiple fires to same file', async () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    initToleranceTelemetryWriter(tmpProjectDir);

    emitToleranceFire(['crlf'], 'a\r\n', 'a\n', 'doc-1');
    emitToleranceFire(['bom'], '﻿hello', 'hello', 'doc-2');

    await teardownToleranceTelemetryWriter();
    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '').class).toBe('crlf');
    expect(JSON.parse(lines[1] ?? '').class).toBe('bom');
  });

  test('multi-class fire produces one line per class', async () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    initToleranceTelemetryWriter(tmpProjectDir);

    emitToleranceFire(['bom', 'crlf', 'trailing-whitespace'], '﻿a   \r\n', 'a\n', 'doc');

    await teardownToleranceTelemetryWriter();
    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);

    const classes = lines.map((l) => JSON.parse(l).class);
    expect(classes).toEqual(['bom', 'crlf', 'trailing-whitespace']);
  });

  test('null document name serializes as null', async () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    initToleranceTelemetryWriter(tmpProjectDir);

    emitToleranceFire(['trailing-newline'], 'hello\n', 'hello', undefined);

    await teardownToleranceTelemetryWriter();
    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    const record = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(record.document).toBeNull();
  });

  test('append-failure warning re-arms after teardown (per-boot warn budget)', async () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    mkdirSync(logPath, { recursive: true });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initToleranceTelemetryWriter(tmpProjectDir);
      emitToleranceFire(['crlf'], 'a\r\n', 'a\n', 'doc');
      await teardownToleranceTelemetryWriter();
      expect(warnSpy.mock.calls.length).toBe(1);

      initToleranceTelemetryWriter(tmpProjectDir);
      emitToleranceFire(['crlf'], 'b\r\n', 'b\n', 'doc');
      await teardownToleranceTelemetryWriter();
      expect(warnSpy.mock.calls.length).toBe(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('teardown stops further writes', async () => {
    process.env.OK_BRIDGE_TOLERANCE_TELEMETRY = '1';
    initToleranceTelemetryWriter(tmpProjectDir);

    emitToleranceFire(['crlf'], 'a\r', 'a', 'doc');
    await teardownToleranceTelemetryWriter();
    emitToleranceFire(['crlf'], 'b\r', 'b', 'doc');

    const logPath = resolve(tmpProjectDir, '.ok', 'local', 'tolerance-telemetry.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
