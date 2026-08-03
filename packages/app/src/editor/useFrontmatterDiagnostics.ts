/**
 * Live frontmatter-schema diagnostics for the active document — the toolbar
 * badge's data source.
 *
 * Frontmatter violations have no body anchor (the WYSIWYG decoration pass
 * skips them by producing plugin), so the editor needs a surface of its own to
 * report them: the badge on the Add-properties button. This hook feeds it.
 *
 * It runs the SAME `lintDocument` entry point the Problems panel does, with
 * every other plugin forced off, rather than reaching for the frontmatter
 * validator directly. Going through the public seam is what keeps the badge
 * count and the panel's frontmatter rows from ever disagreeing — a
 * hand-rolled second call path would drift the moment plugin dispatch,
 * `appliesTo` matching, or schema selection changed on one side only.
 *
 * A second pass rather than a shared one: the toolbar and the doc panel are
 * siblings with no data channel between them, and the panel's diagnostics come
 * bundled with link findings and validation-store bookkeeping that the toolbar
 * has no use for. Disabling the other plugins reduces this pass to a single
 * synchronous ajv validation over the frontmatter object, which is cheap
 * enough that a second pass costs less than lifting the panel's state — but it
 * is the same `useDocDiagnostics` effect, not a copy of it.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { LINT_PLUGINS, type LintDiagnostic, type LinterConfig } from '@inkeep/open-knowledge-core';
import { useDocDiagnostics } from './useDocDiagnostics.ts';

/**
 * Split frontmatter problems by the affordance that can act on them.
 *
 * `missing` names a property the document does not have, so there is no row to
 * mark — it reports on the Add-properties button. `invalid` is a property that
 * exists and is wrong, which the property panel can point at, so it reports on
 * the panel's own count. The validator supplies the distinction
 * (`frontmatterScope`); a diagnostic without it predates the field and is
 * treated as invalid, which keeps it on the panel rather than inviting the user
 * to add something twice.
 *
 * Only `frontmatter`-source diagnostics count. `frontmatterOnly` already keeps
 * the hook's pass to that source today, but the registry is append-designed
 * (`LINT_PLUGIN_IDS`): a future plugin would carry no `frontmatterScope` and
 * silently swell the `invalid` count. Guarding on source here means the two
 * badge counts stay frontmatter-only regardless of what else the pass produces.
 */
export function partitionFrontmatterProblems(diagnostics: readonly LintDiagnostic[]): {
  missing: LintDiagnostic[];
  invalid: LintDiagnostic[];
} {
  const missing: LintDiagnostic[] = [];
  const invalid: LintDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.source !== 'frontmatter') continue;
    if (diagnostic.frontmatterScope === 'missing') missing.push(diagnostic);
    else invalid.push(diagnostic);
  }
  return { missing, invalid };
}

/**
 * `config` with every plugin but frontmatter disabled. Derived from the plugin
 * registry rather than naming markdownlint: the registry is append-designed, so
 * a hardcoded list would silently start running a third plugin's pass here —
 * the same growth `partitionFrontmatterProblems` guards its output against.
 */
function frontmatterOnly(config: LinterConfig): LinterConfig {
  const plugins = { ...config.plugins };
  for (const { id } of LINT_PLUGINS) {
    if (id === 'frontmatter') continue;
    plugins[id] = { ...plugins[id], enabled: false };
  }
  return { ...config, plugins };
}

/**
 * Live `frontmatter`-source diagnostics for `provider`'s doc under `config`.
 * Returns `[]` when either is null, when linting is off, or when the
 * frontmatter plugin is disabled.
 *
 * Delegates to `useDocDiagnostics` with a frontmatter-only config rather than
 * repeating its effect: the debounce, the config-hash key, the observe/
 * unobserve pair, and the cancel-on-teardown guard are all subtleties that
 * would have to stay in lockstep across two copies, and a divergence would be
 * silent. Handing it a `null` config when the plugin is off short-circuits
 * before the async pass instead of relying on `lintDocument` to return empty.
 */
export function useFrontmatterDiagnostics(
  provider: HocuspocusProvider | null,
  config: LinterConfig | null,
): LintDiagnostic[] {
  const active = config?.enabled === true && config.plugins.frontmatter.enabled;
  return useDocDiagnostics(provider, active && config ? frontmatterOnly(config) : null);
}
