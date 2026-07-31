import { describe, expect, test, vi } from 'vitest';
import { PALETTE_COMMANDS, type PaletteCommandContext } from './command-palette-commands';

/**
 * "New skill" was missing from the Cmd+K palette because the registry
 * was backfilled only from native-menu leaves, and New skill was never a menu
 * leaf. Assert it now exists as a palette command and dispatches the blank-skill
 * create seam (closing the palette first), not a bus action.
 */
describe('new-skill palette command (PRD-7604)', () => {
  test('is registered and dispatches createBlankSkill', () => {
    const cmd = PALETTE_COMMANDS.find((c) => c.id === 'new-skill');
    expect(cmd).toBeDefined();
    if (!cmd) return;
    expect(cmd.group).toBe('commands');

    const closePalette = vi.fn();
    const createBlankSkill = vi.fn();
    const ctx = { closePalette, createBlankSkill } as unknown as PaletteCommandContext;
    cmd.dispatch(ctx);

    expect(closePalette).toHaveBeenCalledOnce();
    expect(createBlankSkill).toHaveBeenCalledOnce();
  });
});
