import { describe, expect, test } from 'vitest';
import { terminalStateKeyForContext } from './terminal-state-key';

describe('terminalStateKeyForContext', () => {
  test('uses each loose file identity instead of its shared parent directory', () => {
    expect(
      terminalStateKeyForContext({
        projectPath: '/notes',
        canonicalKey: '/notes/one.md',
        ephemeral: {},
      }),
    ).toBe('/notes/one.md');
    expect(
      terminalStateKeyForContext({
        projectPath: '/notes',
        canonicalKey: '/notes/two.md',
        ephemeral: {},
      }),
    ).toBe('/notes/two.md');
  });

  test('keeps normal projects keyed by their user-facing project path', () => {
    expect(
      terminalStateKeyForContext({
        projectPath: '/symlink/project',
        canonicalKey: '/real/project',
      }),
    ).toBe('/symlink/project');
    expect(terminalStateKeyForContext(null)).toBeNull();
  });
});
