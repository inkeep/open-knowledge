import { describe, expect, test, vi } from 'vitest';
import { PALETTE_COMMANDS, type PaletteCommandContext } from './command-palette-commands';

const openDocInNoteWindow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/open-note-window', () => ({ openDocInNoteWindow }));

/**
 * The palette's half of "Open in New Window". The row must disappear rather
 * than grey out when there is nothing to pop: the palette's availability
 * mechanism only hides, so a row that survives with no active document would be
 * a dead click.
 */
function ctx(over: Partial<PaletteCommandContext>): PaletteCommandContext {
  return {
    bridge: {} as PaletteCommandContext['bridge'],
    singleFile: false,
    activeDocName: 'notes/alpha',
    contextualTargetKind: 'doc',
    viewMenuState: {},
    ...over,
  } as unknown as PaletteCommandContext;
}

describe('open-in-new-window palette command', () => {
  const cmd = PALETTE_COMMANDS.find((c) => c.id === 'open-in-new-window');

  test('is registered in the commands group', () => {
    expect(cmd).toBeDefined();
    expect(cmd?.group).toBe('commands');
  });

  test('is listed when a document is active on the desktop host', () => {
    expect(cmd?.available(ctx({}))).toBe(true);
  });

  test('is hidden when no document is active', () => {
    expect(cmd?.available(ctx({ activeDocName: null }))).toBe(false);
  });

  test('is hidden on the web host, which cannot spawn a window', () => {
    expect(cmd?.available(ctx({ bridge: null }))).toBe(false);
  });

  test('is hidden in a single-file session, which is already one document', () => {
    expect(cmd?.available(ctx({ singleFile: true }))).toBe(false);
  });

  test('closes the palette and pops the active document out, tagged as palette', () => {
    const closePalette = vi.fn();
    cmd?.dispatch(ctx({ closePalette }));

    expect(closePalette).toHaveBeenCalledOnce();
    expect(openDocInNoteWindow).toHaveBeenCalledWith('notes/alpha', 'palette');
  });
});
