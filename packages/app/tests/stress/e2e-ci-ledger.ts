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
];
