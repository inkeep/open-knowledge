import { afterEach, describe, expect, test } from 'vitest';
import {
  readNarrowWorkspaceSession,
  writeNarrowWorkspaceSession,
} from './narrow-workspace-session';

const KEY = 'narrow-session-reader-test';

afterEach(() => {
  window.sessionStorage.clear();
});

describe('readNarrowWorkspaceSession', () => {
  test('reads back a record its writer produced', () => {
    const session = {
      selected: 'agents' as const,
      lastInteracted: 'agents' as const,
      recent: ['agents' as const, 'editor' as const],
      hidden: ['terminal' as const],
    };
    writeNarrowWorkspaceSession(KEY, session);

    expect(readNarrowWorkspaceSession(KEY, true)).toEqual(session);
  });

  test('rejects a record whose selected pane is also hidden', () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        selected: 'editor',
        lastInteracted: 'editor',
        recent: ['editor'],
        hidden: ['editor'],
      }),
    );

    expect(readNarrowWorkspaceSession(KEY, true)).toBeUndefined();
  });
});
