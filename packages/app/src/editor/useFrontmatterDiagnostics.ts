/**
 * Live frontmatter-schema diagnostics for the active document — the toolbar
 * badge's data source.
 *
 * Frontmatter violations have no body anchor (the WYSIWYG decoration pass
 * skips them by scope metadata), so the editor needs a surface of its own to
 * report them: the badge on the Add-properties button. This hook feeds it.
 *
 * It runs the SAME `lintDocument` entry point the Problems panel does, with
 * every plugin that produces no frontmatter diagnostics forced off, rather
 * than reaching for the frontmatter validator directly. Going through the
 * public seam is what keeps the badge count and the panel's frontmatter rows
 * from ever disagreeing — a hand-rolled second call path would drift the
 * moment plugin dispatch, `appliesTo` matching, or schema selection changed on
 * one side only.
 *
 * A second pass rather than a shared one: the toolbar and the doc panel are
 * siblings with no data channel between them, and the panel's diagnostics come
 * bundled with link findings and validation-store bookkeeping that the toolbar
 * has no use for. It is also the same `useDocDiagnostics` effect, not a copy of
 * it, so it costs less than lifting the panel's state.
 *
 * What keeps that second pass cheap is `selectFrontmatterOnlyConfig`: each
 * producer's slice arrives narrowed to its frontmatter half, so a producer that
 * also carries body rules turns them off before they parse anything. Filtering
 * the output instead would still pay for a full document parse per debounce
 * tick on a per-visible-doc render path, for findings this surface discards —
 * and the panel is not there to have already paid it, since the common case is
 * the Problems panel closed.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  isFrontmatterScoped,
  LINT_PLUGINS,
  type LintDiagnostic,
  type LinterConfig,
  selectFrontmatterOnlyConfig,
} from '@inkeep/open-knowledge-core';
import { useDocDiagnostics } from './useDocDiagnostics.ts';

/**
 * Split frontmatter problems by the affordance that can act on them.
 *
 * `missing` names a property the document does not have, so there is no row to
 * mark — it reports on the Add-properties button. `invalid` is a property that
 * exists and is wrong, which the property panel can point at, so it reports on
 * the panel's own count.
 *
 * Only frontmatter-scoped diagnostics count, keyed on the scope metadata the
 * validator stamps rather than on producing plugin: more than one plugin
 * produces frontmatter diagnostics, and the same plugins also produce body
 * findings that carry no scope. Keying on `isFrontmatterScoped` admits every
 * producer's frontmatter findings and keeps everything else — body rules,
 * markdownlint, whatever a future plugin emits without scope — off both badge
 * counts.
 *
 * Both buckets collapse duplicates, each on the identity its own consumers
 * count, because two schemas validating one document can restate one problem.
 *
 * `missing` carries one entry per PROPERTY: every consumer of it — the badge
 * count, the tooltip listing what a click will add, the panel that stages the
 * rows — is counting rows to add, so a per-diagnostic count would advertise two
 * adds and perform one.
 *
 * `invalid` carries one entry per MESSAGE. Those rows already exist, so its
 * consumers count and list FAULTS, not rows, and the property is the wrong key
 * there: two schemas can fault one row for genuinely different reasons (wrong
 * type AND outside an enum) and both belong on the list. The message is the
 * whole of what that surface shows, so two schemas pinning one property the same
 * way state the identical sentence twice, and only that restatement collapses.
 *
 * The first diagnostic of each identity survives, so every entry still carries a
 * message. Deduping here rather than at each consumer is what stops a badge
 * reading 2 from acting on 1.
 */
export function partitionFrontmatterProblems(diagnostics: readonly LintDiagnostic[]): {
  missing: LintDiagnostic[];
  invalid: LintDiagnostic[];
} {
  const missing: LintDiagnostic[] = [];
  const invalid: LintDiagnostic[] = [];
  const named = new Set<string>();
  const stated = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!isFrontmatterScoped(diagnostic)) continue;
    if (diagnostic.frontmatterScope !== 'missing') {
      if (stated.has(diagnostic.message)) continue;
      stated.add(diagnostic.message);
      invalid.push(diagnostic);
      continue;
    }
    const property = diagnostic.frontmatterProperty;
    // An unnamed missing-scope finding has no property to collapse on, so it
    // stays its own entry rather than folding every unnamed one into one.
    if (property !== undefined && property !== '') {
      if (named.has(property)) continue;
      named.add(property);
    }
    missing.push(diagnostic);
  }
  return { missing, invalid };
}

/**
 * Live frontmatter-scoped diagnostics for `provider`'s doc under `config`.
 * Returns `[]` when either is null, when linting is off, or when no
 * frontmatter-producing plugin is enabled.
 *
 * Delegates to `useDocDiagnostics` with a frontmatter-only config rather than
 * repeating its effect: the debounce, the config-hash key, the observe/
 * unobserve pair, and the cancel-on-teardown guard are all subtleties that
 * would have to stay in lockstep across two copies, and a divergence would be
 * silent. Handing it a `null` config when every producer is off short-circuits
 * before the async pass instead of relying on `lintDocument` to return empty.
 *
 * The scope filter still runs on the output. Narrowing decides what the pass
 * COSTS; the filter is what makes the surface's contract independent of it, so
 * a producer that narrows imperfectly cannot put a body finding on the badge.
 */
export function useFrontmatterDiagnostics(
  provider: HocuspocusProvider | null,
  config: LinterConfig | null,
): LintDiagnostic[] {
  const active =
    config?.enabled === true &&
    LINT_PLUGINS.some(
      (plugin) => plugin.frontmatter !== undefined && config.plugins[plugin.id]?.enabled === true,
    );
  const diagnostics = useDocDiagnostics(
    provider,
    active && config ? selectFrontmatterOnlyConfig(config) : null,
  );
  return diagnostics.filter(isFrontmatterScoped);
}
