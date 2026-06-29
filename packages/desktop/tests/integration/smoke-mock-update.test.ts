import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_PATH = join(dirname(__filename), '..', '..', 'scripts', 'smoke-mock-update.mjs');

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSmoke(env: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, OK_UPDATER_FORCE_DEV: '1', MOCK_UPDATE_TIMEOUT_MS: '5000', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf-8');
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf-8');
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('smoke-mock-update.mjs — self-test round-trip', () => {
  test('default (latest) channel: spawns, self-tests, exits 0', async () => {
    const result = await runSmoke({});

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[mock-updater] event=start channel=latest');
    expect(result.stdout).toMatch(/\[mock-updater\] port=\d+/);
    expect(result.stdout).toContain('[mock-updater] event=served path=/latest-mac.yml status=200');
    expect(result.stdout).toContain(
      '[mock-updater] event=served path=/open-knowledge-mock.zip status=200',
    );
    expect(result.stdout).toContain('[mock-updater] event=self-test-ok');
    expect(result.stdout).toContain('[mock-updater] event=shutdown reason=done');
    expect(result.stderr).toBe('');
  }, 15000);

  test('beta channel: serves /beta-mac.yml with default 0.4.0-beta.0 version', async () => {
    const result = await runSmoke({ OK_UPDATER_MOCK_CHANNEL: 'beta' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[mock-updater] event=start channel=beta version=0.4.0-beta.0');
    expect(result.stdout).toContain('[mock-updater] event=served path=/beta-mac.yml status=200');
    expect(result.stdout).toContain('[mock-updater] event=self-test-ok');
    expect(result.stdout).toContain('[mock-updater] event=shutdown reason=done');
    expect(result.stdout).not.toContain('event=served path=/latest-mac.yml');
    expect(result.stderr).toBe('');
  }, 15000);

  test('unsupported channel rejected with exit code 2', async () => {
    const result = await runSmoke({ OK_UPDATER_MOCK_CHANNEL: 'rc' });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unsupported OK_UPDATER_MOCK_CHANNEL=rc');
    expect(result.stdout).not.toContain('event=start');
  }, 15000);
});
