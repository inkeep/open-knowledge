import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirFactory } from '../../../../../test-support/temp-dir.test-helper.ts';
import { readBootLog } from './launch-readiness.ts';
import { mcpStatusMarkerPath, seedMcpConsentComplete } from './mcp-consent.ts';

const makeTempDir = createTempDirFactory(afterEach);

const candidates = [
  { channel: 'Stable', bundle: 'OpenKnowledge.app', homeDir: '.ok', otherHomeDir: '.ok-beta' },
  { channel: 'Beta', bundle: 'OpenKnowledge Beta.app', homeDir: '.ok-beta', otherHomeDir: '.ok' },
];

describe('packaged smoke candidate identity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(candidates)('reads only the selected candidate log for $channel', (candidate) => {
    vi.stubEnv('OK_DESKTOP_PACKAGED_APP', join('/candidate', candidate.bundle));
    vi.stubEnv('OK_CHANNEL', undefined);
    const home = makeTempDir('ok-candidate-log-');
    for (const { directory, event } of [
      { directory: candidate.homeDir, event: 'boot-restore decision' },
      { directory: candidate.otherHomeDir, event: 'unrelated product' },
    ]) {
      const logs = join(home, directory, 'logs');
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'desktop.2026-11-10.log'), `${JSON.stringify({ msg: event })}\n`);
    }

    const log = readBootLog(home);
    expect(log.dir).toBe(join(home, candidate.homeDir, 'logs'));
    expect(log.lastEvent).toBe('boot-restore decision');
    expect(log.lineCount).toBe(1);
  });

  it.each(candidates)(
    'seeds consent where the selected candidate reads it for $channel',
    (candidate) => {
      vi.stubEnv('OK_DESKTOP_PACKAGED_APP', join('/candidate', candidate.bundle));
      vi.stubEnv('OK_CHANNEL', undefined);
      const home = makeTempDir('ok-candidate-consent-');
      const expectedPath = join(home, candidate.homeDir, 'mcp-status.json');

      seedMcpConsentComplete(home);

      expect({ exists: existsSync(expectedPath), reader: mcpStatusMarkerPath(home) }).toEqual({
        exists: true,
        reader: expectedPath,
      });
      expect(JSON.parse(readFileSync(expectedPath, 'utf8'))).toMatchObject({ configured: true });
      expect(existsSync(join(home, candidate.otherHomeDir, 'mcp-status.json'))).toBe(false);
    },
  );
});
