/**
 * Human-facing one-liners for the skills OpenKnowledge ships.
 *
 * These live in `packages/app` — not beside the bundle ids in
 * `packages/server/src/skill-bundles.ts`, where they started — because they are
 * UI copy, and the Lingui extractor only walks this package. Authored there,
 * they rendered English in all ten non-`en` locales while every other string on
 * the page was translated: single-sourcing with the bundle definitions bought
 * less than the catalogs did.
 *
 * Separate from each bundle's SKILL.md `description` on purpose: that field is
 * the AGENT's trigger text (discovery's runs ~600 characters and ends with a
 * `Do NOT load` clause aimed at a model), so a settings row that prints it
 * hands the user a prompt written for something else. The description still
 * backs the install-confirm modal and the preview tab.
 *
 * Keyed by bundle id rather than by frontmatter name: the id is the stable
 * wire value, and a bundle we don't recognize falls back to its description
 * rather than rendering an empty row.
 */

import { useLingui } from '@lingui/react/macro';

/** Returns the localized blurb for a built-in bundle id, or null when the id is
 *  not one we ship copy for (a newer main process, a future bundle). */
export function useBuiltinSkillBlurb(): (id: string) => string | null {
  const { t } = useLingui();
  return (id: string): string | null => {
    switch (id) {
      case 'discovery':
        return t`How to set up new projects with OpenKnowledge.`;
      case 'write-skill':
        return t`How to write a new skill and install it.`;
      case 'project':
        return t`How to use OpenKnowledge and its MCP tools.`;
      default:
        return null;
    }
  };
}
