export interface E2eCiLedgerEntry {
  file: string;
  reason: string;
  evidence: string;
}

export const E2E_CI_EXCLUSIONS: readonly E2eCiLedgerEntry[] = [
  {
    file: 'frontmatter-edit.e2e.ts',
    reason:
      'needs-fixture: FR6 (duplicate-key marker) and FR9 (malformed-YAML banner) seed malformed frontmatter through /api/agent-write-md, which now by design refuses to introduce malformed frontmatter (400 urn:ok:error:frontmatter-malformed). They need a disk-write fixture that loads a pre-malformed doc from the inheritor path — M effort, not in this PR. (The other former failures — the virtual "tags" placeholder row and the banner copy — are stale selectors that a repair would fix in the same pass.)',
    evidence:
      'agent-write-md returns 400 for a duplicate-title / ": : : invalid" frontmatter body; the duplicate-marker and yaml-error-banner surfaces still exist in src (FrontmatterRow / PropertyPanel), so the suite is repairable once the fixture lands',
  },
  {
    file: 'list-keymap.e2e.ts',
    reason:
      'pins live bug inkeep/agents-private#2818 (ordered-list Enter emits "1." instead of the documented position-based "2.") plus a second stable red on the same surface: Enter at the end of a task item writes the new empty item as "- [ ] &#x20;", entity-escaping the trailing space. Both reproduce identically on main, so neither is the cutover\'s. inkeep/agents-private#2817 — Tab/Shift-Tab list indent/outdent never reaching Y.Text — was this entry\'s main justification and is FIXED by the single-CRDT cutover: there is no fragment to mutate and no normalizeBridge step to strip the indent, so the keystroke writes the indented bytes itself. Promote the file when the two Enter rows are fixed and the three races below are stabilised.',
    evidence:
      'measured 2026-09-09, three full-file runs per side, single file per playwright invocation. FIXED by the cutover: "Tab inside a listItem increases list depth" and "Shift-Tab inside a nested listItem lifts it one level" are red 3/3 on main (30397303) and green 3/3 on this branch. STABLE RED on BOTH sides: ordered Enter settles to "1. sf\\n1. "; task Enter settles to "- [ ] sf\\n- [ ] &#x20;". RACES, red on both sides at similar rates and never in the same combination twice: "Typing \\"1. \\" below a bullet list" (1 red of 3 each side), and the two nested boundary merges — at --repeat-each=5 with only that describe running, Backspace-merge is 5/5 green on main and 4/5 on the branch, Delete-merge 2/5 green on main and 4/5 on the branch, so the branch is not the worse side. The merge logic itself is proven at the unit tier (list-boundary-merge.test.ts)',
  },
  {
    file: 'okignore-settings.e2e.ts',
    reason:
      'pins live regression inkeep/agents-private#2816: right-click "Hide this file"/"Hide folder" commits the .okignore pattern and shows its toast, but the sidebar row never disappears — the tree fetches a showAll disk walk whose client-side filter has no okignore awareness, so no rebuild/CC1/refetch can remove the row. The 2 US-013 tests are correct RED specs of that bug. (The 4 US-010 settings-navigation drift tests were repaired in this PR.) Promote in the fix PR.',
    evidence:
      'after the US-010 repair, 17 pass / 2 fail locally; the 2 Hide tests fail deterministically (row visible for the full 10s window) while the success toast fires and the pattern lands in Settings',
  },
];
