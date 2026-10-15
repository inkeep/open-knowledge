import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

export function expectNoAutomaticGitMaintenance(repository, env = gitCleanEnv()) {
  const traceDir = mkdtempSync(join(tmpdir(), 'ok-script-git-trace-'));
  const tracePath = join(traceDir, 'events.jsonl');
  try {
    const operation = spawnSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'maintenance.autoDetach=true',
        '-c',
        'maintenance.strategy=incremental',
        '-c',
        'maintenance.loose-objects.auto=-1',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'fixture operation',
      ],
      {
        cwd: repository,
        env: {
          ...gitCleanEnv(env),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TRACE2_EVENT: tracePath,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      },
    );
    assert.equal(operation.error, undefined);
    assert.equal(operation.status, 0, operation.stderr);
    const events = [join(repository, '.git', 'fixture-maintenance.jsonl'), tracePath].flatMap(
      (path) => {
        const entries = readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.ok(
          entries.some((event) => event.event === 'version'),
          'Git emitted no Trace2 version event',
        );
        return entries;
      },
    );
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.event === 'child_start' && ['maintenance', 'gc'].includes(event.argv?.[1]),
        )
        .map((event) => event.argv),
      [],
      'fixture Git operation launched automatic maintenance',
    );
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
}
