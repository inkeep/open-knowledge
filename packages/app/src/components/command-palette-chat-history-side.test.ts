import { describe, expect, test } from 'vitest';
import { PALETTE_COMMANDS, type PaletteCommandContext } from './command-palette-commands';

function offeredChatHistoryMoves(chatHistorySide: 'left' | 'right'): string[] {
  const ctx = {
    bridge: null,
    singleFile: false,
    activeDocName: null,
    viewMenuState: {},
    chatHistorySide,
  } as unknown as PaletteCommandContext;
  return PALETTE_COMMANDS.filter(
    (command) => command.id.startsWith('move-chat-history-') && command.available(ctx),
  ).map((command) => command.id);
}

describe('chat history side palette commands', () => {
  test.each([
    ['right', ['move-chat-history-left']],
    ['left', ['move-chat-history-right']],
  ] as const)(
    'with chat history on the %s, the palette offers only the move to the other side',
    (side, offered) => {
      expect(offeredChatHistoryMoves(side)).toEqual(offered);
    },
  );
});
