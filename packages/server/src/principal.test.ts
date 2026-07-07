import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { loadPrincipal } from './principal.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-principal-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadPrincipal — first run', () => {
  test('creates principal.json under .ok/local/', async () => {
    const principal = await loadPrincipal(tmpDir);
    const path = resolve(tmpDir, '.ok', LOCAL_DIR, 'principal.json');
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw.id).toBe(principal.id);
  });

  test('id starts with principal-', async () => {
    const principal = await loadPrincipal(tmpDir);
    expect(principal.id.startsWith('principal-')).toBe(true);
  });

  test('created_at is an ISO 8601 string', async () => {
    const principal = await loadPrincipal(tmpDir);
    expect(principal.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('synthesized source when no git config available', async () => {
    const principal = await loadPrincipal(tmpDir);
    // git config returns empty for a non-git tmpDir with no global config
    // (source may be 'synthesized' or 'git-config' depending on local env)
    expect(['git-config', 'synthesized']).toContain(principal.source);
  });
});

describe('loadPrincipal — idempotence', () => {
  test('second call returns same id and created_at', async () => {
    const first = await loadPrincipal(tmpDir);
    const second = await loadPrincipal(tmpDir);
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
  });

  test('second call preserves id even if on-disk file is partially corrupted', async () => {
    const first = await loadPrincipal(tmpDir);
    // Partially corrupt by removing display fields
    const path = resolve(tmpDir, '.ok', LOCAL_DIR, 'principal.json');
    const minimal = { id: first.id, created_at: first.created_at };
    writeFileSync(path, JSON.stringify(minimal), 'utf-8');

    const second = await loadPrincipal(tmpDir);
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    // display fields should be filled in
    expect(typeof second.display_name).toBe('string');
    expect(second.display_name.length).toBeGreaterThan(0);
  });

  test('corrupt JSON is recovered — new principal synthesized', async () => {
    mkdirSync(resolve(tmpDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(resolve(tmpDir, '.ok', LOCAL_DIR, 'principal.json'), '{invalid json', 'utf-8');
    const principal = await loadPrincipal(tmpDir);
    expect(principal.id.startsWith('principal-')).toBe(true);
  });
});

describe('loadPrincipal — display field refresh', () => {
  test('display_name and display_email are strings', async () => {
    const principal = await loadPrincipal(tmpDir);
    expect(typeof principal.display_name).toBe('string');
    expect(typeof principal.display_email).toBe('string');
  });

  test('synthesized email has principal-<shortId>@openknowledge.local shape', async () => {
    // In a bare tmpDir with no git config, the email may be synthesized
    const principal = await loadPrincipal(tmpDir);
    if (principal.source === 'synthesized') {
      expect(principal.display_email).toMatch(/@openknowledge\.local$/);
    }
  });
});
