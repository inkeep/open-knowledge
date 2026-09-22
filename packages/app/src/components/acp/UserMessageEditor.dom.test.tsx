import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EMPTY_MENTION_RECENCY } from '@/editor/composer-mention/composer-mention';
import { MentionRecencyContext } from './mention-recency-context';
import { UserMessageEditor } from './UserMessageActions';

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
});

function editor() {
  return (
    <UserMessageEditor
      initialText="try again"
      currentAgent={{ source: 'registry', id: 'claude', name: 'Claude Agent' }}
      canSendHere
      onCancel={() => {}}
      onSend={() => Promise.resolve()}
    />
  );
}

describe('UserMessageEditor and its recency provider', () => {
  test('rendered with no provider above it, it fails loud rather than quietly losing the @ order', () => {
    expect(() => render(editor())).toThrow(/requires MentionRecencyContext/);
  });

  test('under an explicit provider the real, unmocked editor mounts without a single console error', () => {
    render(<MentionRecencyContext value={EMPTY_MENTION_RECENCY}>{editor()}</MentionRecencyContext>);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
