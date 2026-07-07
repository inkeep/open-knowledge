import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { resolveLocalSinkConfig } from './local-sink-resolver';

describe('resolveLocalSinkConfig', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-local-sink-resolver-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
    // Default fixture: empty project config so readConfigSafely returns
    // schema-defaulted values (sink on, default caps, default denylist).
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    delete process.env.OK_DISABLE_LOCAL_SINK;
  });

  function seedProject(value: unknown): void {
    writeFileSync(join(projectDir, '.ok', 'config.yml'), stringifyYaml(value));
  }

  function seedProjectLocal(value: unknown): void {
    writeFileSync(join(projectDir, '.ok', 'local', 'config.yml'), stringifyYaml(value));
  }

  it('returns the default sink config when no config files set anything', () => {
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('expected non-null sink');
    expect(resolved.telemetry.projectDir).toBe(projectDir);
    expect(resolved.telemetry.spansMaxBytes).toBe(52_428_800);
    expect(resolved.logs.maxBytes).toBe(26_214_400);
    expect(resolved.telemetry.attributeDenylist).toContain('authorization');
    expect(resolved.telemetry.attributeDenylist).toContain('cookie');
  });

  it('returns null when OK_DISABLE_LOCAL_SINK=1 — test-only opt-out', () => {
    process.env.OK_DISABLE_LOCAL_SINK = '1';
    expect(resolveLocalSinkConfig({ projectDir })).toBeNull();
  });

  it('returns null when OK_DISABLE_LOCAL_SINK=true', () => {
    process.env.OK_DISABLE_LOCAL_SINK = 'true';
    expect(resolveLocalSinkConfig({ projectDir })).toBeNull();
  });

  it('returns null when project config sets telemetry.localSink.enabled: false', () => {
    seedProject({ telemetry: { localSink: { enabled: false } } });
    expect(resolveLocalSinkConfig({ projectDir })).toBeNull();
  });

  it('returns null when project-local config sets enabled: false (project-local wins)', () => {
    // Project keeps the default-on sink; project-local opts the operator out.
    seedProject({ telemetry: { localSink: { enabled: true } } });
    seedProjectLocal({ telemetry: { localSink: { enabled: false } } });
    expect(resolveLocalSinkConfig({ projectDir })).toBeNull();
  });

  it('returns the sink when project disables but project-local re-enables (project-local wins)', () => {
    // Inverse of the typical override — sanity-checks symmetry.
    seedProject({ telemetry: { localSink: { enabled: false } } });
    seedProjectLocal({ telemetry: { localSink: { enabled: true } } });
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
  });

  it('cascades per-leaf: project-local spans.maxBytes wins over project', () => {
    seedProject({
      telemetry: { localSink: { spans: { maxBytes: 99 } } },
    });
    seedProjectLocal({
      telemetry: { localSink: { spans: { maxBytes: 7 } } },
    });
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('expected non-null sink');
    expect(resolved.telemetry.spansMaxBytes).toBe(7);
  });

  it('cascades per-leaf: project-local logs.maxBytes wins over project', () => {
    seedProject({
      telemetry: { localSink: { logs: { maxBytes: 999 } } },
    });
    seedProjectLocal({
      telemetry: { localSink: { logs: { maxBytes: 17 } } },
    });
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('expected non-null sink');
    expect(resolved.logs.maxBytes).toBe(17);
  });

  it('cascades per-leaf: project-local attributeDenylist wins over project', () => {
    // The denylist is value-replace (not merge) — operators who override
    // expect their list to be authoritative.
    seedProject({
      telemetry: { localSink: { attributeDenylist: ['project-only'] } },
    });
    seedProjectLocal({
      telemetry: { localSink: { attributeDenylist: ['local-only'] } },
    });
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('expected non-null sink');
    expect(resolved.telemetry.attributeDenylist).toEqual(['local-only']);
  });

  it('falls back to project value when project-local is silent for that leaf', () => {
    seedProject({
      telemetry: {
        localSink: {
          spans: { maxBytes: 555 },
          logs: { maxBytes: 222 },
        },
      },
    });
    // project-local does not override either cap.
    seedProjectLocal({});
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('expected non-null sink');
    expect(resolved.telemetry.spansMaxBytes).toBe(555);
    expect(resolved.logs.maxBytes).toBe(222);
  });

  it('anchors both sink configs on projectDir (not content.dir)', () => {
    // The sink files are per-machine runtime state and must land under
    // `<projectDir>/.ok/local/`, alongside server.lock / principal.json /
    // state.json — NOT inside a `content.dir` sub-folder. Anchoring on
    // content.dir would spawn a second `.ok/` whenever `content.dir != '.'`.
    // The resolver reads config from projectDir and threads projectDir
    // through to both sink configs.
    const resolved = resolveLocalSinkConfig({ projectDir });
    expect(resolved).not.toBeNull();
    if (resolved === null) throw new Error('expected non-null sink');
    expect(resolved.telemetry.projectDir).toBe(projectDir);
    expect(resolved.logs.projectDir).toBe(projectDir);
  });
});
