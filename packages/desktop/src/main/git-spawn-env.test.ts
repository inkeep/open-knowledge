import { afterEach, describe, expect, it } from 'vitest';
import { gitSpawnEnv } from './git-spawn-env.ts';

const ORIGINAL_SOCK = process.env.SSH_AUTH_SOCK;

afterEach(() => {
  if (ORIGINAL_SOCK === undefined) {
    delete process.env.SSH_AUTH_SOCK;
  } else {
    process.env.SSH_AUTH_SOCK = ORIGINAL_SOCK;
  }
});

describe('gitSpawnEnv', () => {
  it('pins an English locale', () => {
    const env = gitSpawnEnv();
    expect(env.LANG).toBe('C');
    expect(env.LC_ALL).toBe('C');
  });

  it('reflects SSH_AUTH_SOCK changes made after a prior call', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/before.sock';
    expect(gitSpawnEnv().SSH_AUTH_SOCK).toBe('/tmp/before.sock');
    // The startup harvest patches process.env once; a frozen snapshot here
    // would pin every later git spawn to the pre-harvest socket.
    process.env.SSH_AUTH_SOCK = '/tmp/after.sock';
    expect(gitSpawnEnv().SSH_AUTH_SOCK).toBe('/tmp/after.sock');
  });

  it('keeps the augmented PATH stable across calls', () => {
    expect(gitSpawnEnv().PATH).toBe(gitSpawnEnv().PATH);
  });
});
