import { describe, expect, test, vi } from 'vitest';
import { PALETTE_COMMANDS, type PaletteCommandContext } from './command-palette-commands';

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
