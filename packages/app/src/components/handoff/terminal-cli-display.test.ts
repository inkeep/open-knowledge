import { describe, expect, it } from 'bun:test';
import { TERMINAL_CLI_IDS } from '@inkeep/open-knowledge-core';
import { visibleTerminalClis } from './terminal-cli-display';

/** A complete resolved probe map (every CLI keyed), all reported absent. Matches
 *  the shape `resolveCliInstalledMap` returns — the renderer only ever sees a
 *  complete map or the empty `{}` (unresolved). */
const allAbsent = Object.fromEntries(TERMINAL_CLI_IDS.map((cli) => [cli, false]));

describe('visibleTerminalClis', () => {
  it('fails open on the empty map (probe unresolved / failed / older bridge)', () => {
    // Regression guard: an empty map is "unknown", NOT "none installed". Hiding
    // here would silently drop genuinely-installed CLIs from every launch surface
    // for the whole session whenever the probe never resolves.
    expect(visibleTerminalClis({})).toEqual([...TERMINAL_CLI_IDS]);
  });

  it('hides only CLIs the probe positively reports absent', () => {
    expect(visibleTerminalClis({ ...allAbsent, codex: true, cursor: true })).toEqual([
      'claude',
      'codex',
      'cursor',
    ]);
  });

  it('always keeps Claude — the install-nudge anchor — even when probed absent', () => {
    expect(visibleTerminalClis(allAbsent)).toEqual(['claude']);
  });

  it('keeps `keep` (the current pick) even when probed absent', () => {
    // A picker's own selected CLI must stay in its dropdown so it can be re-picked
    // and shows its checkmark, even if the probe says it's not on PATH.
    expect(visibleTerminalClis(allAbsent, 'codex')).toEqual(['claude', 'codex']);
  });

  it('preserves TERMINAL_CLI_IDS launch order', () => {
    const allInstalled = Object.fromEntries(TERMINAL_CLI_IDS.map((cli) => [cli, true]));
    expect(visibleTerminalClis(allInstalled)).toEqual([...TERMINAL_CLI_IDS]);
  });
});
