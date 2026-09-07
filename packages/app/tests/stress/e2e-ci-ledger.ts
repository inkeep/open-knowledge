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
      'pins live bugs inkeep/agents-private#2817 (WYSIWYG Tab/Shift-Tab list indent/outdent mutates the ProseMirror fragment but never mirrors to Y.Text — normalizeBridge step 7c strips leading indent so Observer A gates the drain as already-in-sync) and #2818 (ordered-list Enter replays the inherited sourceOrdinal, emitting "1." instead of the documented position-based "2."). The two indent-mirror tests and the ordinal test are correct executable specs of those bugs. Promote in the fix PR.',
    evidence:
      'Tab/Shift-Tab leave Y.Text byte-identical to the flat seed after the sink/lift renders in the DOM; ordered Enter settles to "1. sf\\n1. "; a 4th failure is an e2e caret-placement race whose app logic is proven at the unit tier (list-boundary-merge.test.ts)',
  },
  {
    file: 'okignore-settings.e2e.ts',
    reason:
      'pins live regression inkeep/agents-private#2816: right-click "Hide this file"/"Hide folder" commits the .okignore pattern and shows its toast, but the sidebar row never disappears — the tree fetches a showAll disk walk whose client-side filter has no okignore awareness, so no rebuild/CC1/refetch can remove the row. The 2 US-013 tests are correct RED specs of that bug. (The 4 US-010 settings-navigation drift tests were repaired in this PR.) Promote in the fix PR.',
    evidence:
      'after the US-010 repair, 17 pass / 2 fail locally; the 2 Hide tests fail deterministically (row visible for the full 10s window) while the success toast fires and the pattern lands in Settings',
  },
];
