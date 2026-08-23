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
 * Keyed by BOTH the bundle id and the frontmatter name, because the two
 * surfaces that need a blurb learn about a bundle from different places: the
 * rows read `/api/skills`, which reports on-disk skills and knows only names;
 * the first-visit intro reads the desktop bridge, which enumerates the bundles
 * the app ships and knows only ids. One switch with both keys beats a mapping
 * table nobody would remember to extend. A bundle we don't recognize falls back
 * to its description rather than rendering an empty row.
 */

import { useLingui } from '@lingui/react/macro';

/** Returns the localized blurb for a built-in bundle id OR skill name, or null
 *  when it is not one we ship copy for (a newer server, a future bundle). */
export function useBuiltinSkillBlurb(): (idOrName: string) => string | null {
  const { t } = useLingui();
  return (idOrName: string): string | null => {
    switch (idOrName) {
      case 'discovery':
      case 'open-knowledge-discovery':
        return t`How to set up new projects with OpenKnowledge.`;
      case 'write-skill':
      case 'open-knowledge-write-skill':
        return t`How to write a new skill and install it.`;
      case 'project':
      case 'open-knowledge':
        return t`How to use OpenKnowledge and its MCP tools.`;
      default:
        return null;
    }
  };
}

/**
 * The bundle DIRECTORY behind a `/api/skills` entry, which is what the preview
 * tab addresses a built-in by. The list reports `absolutePath` (the SKILL.md);
 * the containing dir is the bundle. Returns null when the entry carries no
 * absolute path — partial entries built client-side before the list loads.
 *
 * Windows separators are handled too: the server sends native paths, and a
 * `/`-only strip would leave a preview source ending in `\SKILL.md`.
 */
export function builtinBundleDir(absolutePath: string | undefined): string | null {
  if (!absolutePath) return null;
  const cut = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'));
  return cut > 0 ? absolutePath.slice(0, cut) : null;
}
