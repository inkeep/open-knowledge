/**
 * CI-exclusion ledger for `tests/stress/*.e2e.ts`.
 *
 * CI's Playwright tier runs the fixed file list in this package's `test:e2e`
 * script — not a glob. Any stress e2e file absent from that list NEVER runs in
 * CI, silently. This ledger is the explicit, reviewed record of every file
 * that is deliberately NOT in the CI list, each with a reason and the local
 * run evidence backing it. The membership meta-guard
 * (`tests/meta/e2e-ci-membership.test.ts`) fails when a stress e2e file is in
 * neither the CI list nor this ledger, when a file is in both, or when either
 * side references a file that no longer exists.
 *
 * To promote a ledgered file into CI: verify it is deterministic-green on
 * consecutive local runs and cheap enough for the 15-minute CI job, append it
 * to the `test:e2e` script in package.json, and delete its entry here.
 */

export interface E2eCiLedgerEntry {
  /** Bare filename under tests/stress/, e.g. 'edit-with-ai.e2e.ts'. */
  file: string;
  /** Why the file is excluded from the CI `test:e2e` list. */
  reason: string;
  /** Observed local-run evidence backing the reason (verdict + wall-clock). */
  evidence: string;
}

export const E2E_CI_EXCLUSIONS: readonly E2eCiLedgerEntry[] = [
  {
    file: 'asset-embed-real-fidelity.e2e.ts',
    reason:
      'fails-locally: QA-004 (real ZIP) and QA-006 (real CSV) byte-identity assertions fail — on-disk sha256/content does not match the uploaded bytes',
    evidence: 'same 2 tests failed in 2/2 local runs (2026-07-20); other 5 tests green',
  },
  {
    file: 'clipboard-relative-url-source-fallback.e2e.ts',
    reason:
      'fails-locally: QA-005 inline image in a paragraph emits chunk-wrapper HTML instead of the inline markdown source-fallback; deterministic, fix open in PR #2505',
    evidence: 'QA-005 failed deterministically in local run (2026-07-20); remaining tests green',
  },
  {
    file: 'edit-with-ai.e2e.ts',
    reason:
      'fails-locally: all 13 tests fail toBeVisible — Edit-with-AI rows are desktop-gated (window.okDesktop) and never render in the browser e2e harness without a forced-gate init script',
    evidence: '13/18 failed, uniform toBeVisible timeouts, local run (2026-07-20)',
  },
  {
    file: 'frontmatter-edit.e2e.ts',
    reason:
      'fails-locally: 5 PropertyPanel assertions fail (rename keeps position, drag reorder, keyboard drag, duplicate-name marker, malformed-YAML banner)',
    evidence: 'same 5 tests failed in 2/2 local runs (2026-07-20)',
  },
  {
    file: 'graph-panel-surfaces.e2e.ts',
    reason:
      'fails-locally + ci-budget: fullscreen-graph interaction tests hit the 120s per-test timeout one after another even solo at low machine load; a solo run exceeds 15 minutes',
    evidence:
      '11 failed under batch run; solo re-run at low load kept failing each test at the 120s cap and was abandoned after ~15m (2026-07-20)',
  },
  {
    file: 'list-keymap.e2e.ts',
    reason:
      'fails-locally: Tab/Shift-Tab list-depth tests receive a flat list (Tab no longer indents) and ordered-item Enter assertion fails',
    evidence: 'same 3 tests failed in 2/2 local runs (2026-07-20); other 12 green, 1 skipped',
  },
  {
    file: 'okignore-settings.e2e.ts',
    reason:
      'fails-locally: 6 tests fail (US-010 advanced-textarea group + US-013 hide-file/folder patterns); also expensive at ~2.9m solo',
    evidence: '6 failed / 13 passed solo at low load, 2.9m wall (2026-07-20)',
  },
  {
    file: 'outline-navigation.e2e.ts',
    reason:
      'fails-locally: outline-click landing assertions fail (WYSIWYG scroll landing, source-mode cursor line, code-fence # disambiguation)',
    evidence: '4/5 failed in re-run at low load (2026-07-20)',
  },
  {
    file: 'prop-upload.e2e.ts',
    reason:
      'fails-locally: 5 assertions expect src "initial.png" but receive "/initial.png" (leading-slash drift in upload src handling)',
    evidence: 'same 5 tests failed in 2/2 local runs (2026-07-20)',
  },
  {
    file: 'rename-consolidation.e2e.ts',
    reason:
      'fails-locally: 3 browser-fidelity assertions fail (rename response contract returns undefined where true expected; /api/history reachability)',
    evidence:
      'same 3 tests failed in 2/2 local runs (2026-07-20); tmpdir content dir is not a git repo, rename falls back to fs rename',
  },
  {
    file: 'rename-content-preservation.e2e.ts',
    reason:
      'fails-locally: "renaming the active doc keeps navigation on the renamed doc" fails toBeGreaterThan(0) on 0',
    evidence: 'same single test failed in 2/2 local runs (2026-07-20); other 3 green',
  },
  {
    file: 'slash-command-auto-open.e2e.ts',
    reason:
      'fails-locally: SLASH-AUTOOPEN-IMG-MULTI expects 2 [data-jsx-component] nodes after inserting a second Image, receives 1',
    evidence: 'same single test failed in 2/2 local runs (2026-07-20); other 21 tests green',
  },
  {
    file: 'timeline-diff-sidepane.e2e.ts',
    reason:
      'fails-locally: all 14 side-pane tests fail element-not-found / toBeVisible — the timeline diff side pane never appears in the harness',
    evidence: '14/16 failed in 2/2 local runs (2026-07-20); also expensive (>4m per run)',
  },
];
