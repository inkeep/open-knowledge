import { OkCliCommand } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { authCommand } from './index.ts';

const STABLE_READS = new Set(['status', 'repos', 'git-credential']);

describe('auth verbs on a dev build that falls back to the installed CLI', () => {
  test('every registered verb is refused unless it is a declared read of Stable', () => {
    const cli = OkCliCommand.resolve({ env: { OK_CHANNEL: 'dev' } });
    const verbs = authCommand().commands.map((command) => command.name());
    expect(verbs.length).toBeGreaterThan(STABLE_READS.size);
    for (const verb of verbs) {
      expect({ verb, refused: cli.refusalFor(['auth', verb]) !== undefined }).toEqual({
        verb,
        refused: !STABLE_READS.has(verb),
      });
    }
  });
});
