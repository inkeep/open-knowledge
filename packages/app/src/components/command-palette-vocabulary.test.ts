/**
 * Vocabulary contract for the ⌘K command palette.
 *
 * The matcher decides whether a row is admitted once the user's words are in
 * its searchable text. This file covers the other half: whether the words a
 * user is likely to type are in that text at all. Commands are named by the
 * product ("Move to Trash", "Reveal in Finder") while users search by intent
 * ("delete file", "show in folder"), so the registry has to carry both.
 *
 * Each row below is one realistic phrasing paired with the command it should
 * reach. A failure here is not necessarily a bug in the matcher — it usually
 * means a command's keywords no longer carry a word people search by, which is
 * how a command becomes unreachable without anything looking broken.
 */
import { COMMAND_IDENTITIES, MENU_LABELS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { matchesCommandQuery } from '@/components/command-palette-search';

/**
 * Every label a row can actually render. A state toggle shows "Show X" in one
 * state and "Hide X" in the other, and the agent panel additionally renders an
 * override label over a selection — so pinning a single `labelKey` would model a
 * string the user may never see, and would let a command look reachable while
 * being unreachable for half the app's runtime.
 */
const renderableLabels = (command: (typeof COMMAND_IDENTITIES)[number]): string[] => {
  const keys = [
    command.labelKey,
    command.stateToggle?.showKey,
    command.stateToggle?.hideKey,
    command.stateToggle?.overrideKey,
    command.placementToggle?.bottomKey,
    command.placementToggle?.rightKey,
  ].filter((key) => key !== undefined);
  const resolved = [...new Set(keys)].map((key) => MENU_LABELS[key]).filter((label) => !!label);
  return resolved.length > 0 ? resolved : [''];
};

const paletteRows = COMMAND_IDENTITIES.filter((command) => command.palette).map((command) => ({
  id: command.id,
  labels: renderableLabels(command),
  keywords: command.keywords,
}));

/** Rows admitted in EVERY state they can render in. */
const commandsMatching = (query: string): string[] =>
  paletteRows
    .filter((row) => row.labels.every((label) => matchesCommandQuery(label, query, row.keywords)))
    .map((row) => row.id);

/** Rows admitted in AT LEAST ONE state — the gap between this and the above is state-dependence. */
const commandsMatchingSomeState = (query: string): string[] =>
  paletteRows
    .filter((row) => row.labels.some((label) => matchesCommandQuery(label, query, row.keywords)))
    .map((row) => row.id);

/** Realistic phrasing -> the command the user is trying to reach. */
const INTENTS: ReadonlyArray<readonly [string, string]> = [
  // Bug reporting. "file bug" is the phrasing that went unmatched in the wild.
  ['file bug', 'report-bug'],
  ['report problem', 'report-bug'],
  ['report issue', 'report-bug'],
  ['past reports', 'bug-report-history'],

  // Destructive and file actions, named by product vs searched by intent.
  ['delete file', 'move-to-trash'],
  ['delete folder', 'move-to-trash'],
  ['remove file', 'move-to-trash'],
  ['rename file', 'rename'],
  ['copy file', 'duplicate'],
  ['duplicate folder', 'duplicate'],
  ['copy absolute path', 'copy-full-path'],
  ['copy relative path', 'copy-relative-path'],
  ['show in folder', 'reveal-in-finder'],
  ['open in finder', 'reveal-in-finder'],

  // Creation. Users say "document" and "note"; the command says "file".
  ['new document', 'new-file'],
  ['create note', 'new-file'],
  ['new note', 'new-file'],
  ['new directory', 'new-folder'],
  ['create directory', 'new-folder'],
  ['create from template', 'new-from-template'],
  ['create project', 'new-project'],
  ['create skill', 'new-skill'],
  ['open single file', 'open-file'],

  // Panels, named by their current state ("Show Terminal") but searched by verb.
  ['open terminal', 'toggle-terminal'],
  ['show console', 'toggle-terminal'],
  ['new terminal tab', 'new-terminal'],
  ['close terminal', 'kill-terminal'],
  ['stop terminal', 'kill-terminal'],
  ['move terminal right', 'move-terminal'],
  ['open chat', 'toggle-agent-panel'],
  ['open agents', 'toggle-agent-panel'],
  ['show ai', 'toggle-agent-panel'],
  ['document info', 'toggle-doc-panel'],
  ['show properties', 'toggle-doc-panel'],
  ['hide files', 'toggle-sidebar'],
  ['files panel', 'toggle-sidebar'],
  ['show graph', 'open-graph'],
  ['graph view', 'open-graph'],

  // Projects and worktrees.
  ['change project', 'switch-project'],
  ['open project', 'open-folder'],
  ['create worktree', 'new-worktree'],
  ['change branch', 'switch-worktree'],
  ['checkout branch', 'switch-worktree'],

  // Tree and file-visibility toggles.
  ['expand folders', 'expand-all-tree'],
  ['collapse folders', 'collapse-all-tree'],
  ['show dotfiles', 'toggle-show-hidden-files'],
  ['hidden files', 'toggle-show-hidden-files'],
  ['only markdown', 'toggle-show-only-markdown-files'],
  ['skills section', 'toggle-show-skills-section'],
  ['show ok folders', 'toggle-show-ok-folders'],
  ['show sidebar', 'toggle-sidebar'],
  ['hide document panel', 'toggle-doc-panel'],
  ['hide agents', 'toggle-agent-panel'],

  // App-level.
  ['open settings', 'settings'],
  ['open preferences', 'settings'],
  ['check version', 'check-for-updates'],
  ['update app', 'check-for-updates'],
  ['browse skills', 'open-skills'],
  ['open skills', 'open-skills'],
  ['install skill', 'open-skills'],
  ['view source', 'open-github'],
  ['open repo', 'open-github'],
  ['setup mcp', 'set-up-integrations'],
  ['configure claude', 'set-up-integrations'],
  ['install claude', 'install-claude-desktop'],
  ['give feedback', 'send-feedback'],
  ['send suggestion', 'send-feedback'],
  ['spell check', 'toggle-spell-check'],
  ['new window', 'open-in-new-window'],
  ['pop out', 'open-in-new-window'],
  ['starter pack', 'initialize-starter-pack'],
  ['close window', 'close-tab'],
  ['go back', 'navigate-back'],
  ['go forward', 'navigate-forward'],
  ['play game', 'open-blob-run'],
];

describe('command palette vocabulary', () => {
  test.each(INTENTS)('"%s" reaches %s', (query, expectedId) => {
    expect(commandsMatching(query)).toContain(expectedId);
  });

  test('no intent is answered in only some of a command’s render states', () => {
    // A row whose keywords carry only one polarity ("show" but not "hide")
    // answers the intent while one label is showing and goes silent when the
    // other is. That reads as a working command until the moment it is not, so
    // the two derivations have to agree.
    const stateDependent = INTENTS.filter(
      ([query, id]) =>
        commandsMatchingSomeState(query).includes(id) && !commandsMatching(query).includes(id),
    ).map(([query, id]) => `${query} -> ${id}`);

    expect(stateDependent).toEqual([]);
  });

  test('every intent resolves to a usefully short list', () => {
    // Pinned just above the measured ceiling rather than at a round number: as
    // written, every intent resolves to exactly one command, so a threshold with
    // slack in it would absorb a large ambiguity increase before complaining.
    const tooBroad = INTENTS.map(([query]) => [query, commandsMatching(query).length] as const)
      .filter(([, count]) => count > 2)
      .map(([query, count]) => `${query} -> ${count} rows`);

    expect(tooBroad).toEqual([]);
  });

  test('a broad single word stays inside a committed ceiling', () => {
    // The all-terms rule makes two-word intents inherently narrow, so the guard
    // above barely moves when broad tokens are added. Single words are where a
    // keyword sweep actually widens the palette, so the ceiling lives here.
    // Raising a number below means a sweep made a common word noisier; that
    // should be a deliberate edit, not a silent side effect.
    const ceilings: ReadonlyArray<readonly [string, number]> = [
      ['open', 13],
      ['file', 11],
      ['show', 12],
      ['new', 9],
      ['create', 7],
      ['folder', 10],
      ['view', 3],
      ['go', 3],
    ];
    const over = ceilings
      .map(([word, max]) => [word, commandsMatchingSomeState(word).length, max] as const)
      .filter(([, count, max]) => count > max)
      .map(([word, count, max]) => `${word} -> ${count} rows (ceiling ${max})`);

    expect(over).toEqual([]);
  });

  test('a query whose terms match nothing returns nothing', () => {
    expect(commandsMatching('zzzznomatch')).toEqual([]);
    expect(commandsMatching('bug zzzznomatch')).toEqual([]);
  });
});
