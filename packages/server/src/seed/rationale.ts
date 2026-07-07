/**
 * Pure renderer for a starter pack's *organizing principle* — the per-folder
 * "why" plus the templates each folder ships.
 *
 * This is the reference-for-inspiration surface: it lets an agent or human see
 * how a pack is structured and the reasoning behind each folder *without*
 * scaffolding anything, so they can build a SIMILAR structure adapted to their
 * own domain rather than cloning the pack.
 *
 * Single source of truth: every string here is read from `STARTER_PACKS`
 * (`StarterFolder.description` is already authored as the primary
 * agent-guidance surface). Nothing is duplicated. The function is plain text
 * (no ANSI) so every seed consumer can reuse it — the CLI dry-run today, the
 * desktop/HTTP seed preview later — and apply its own presentation.
 */

import type { StarterFolder, StarterPack } from './starter.ts';

/**
 * The reference, not the recipe. Tells the reader to adapt the pattern rather
 * than copy the folders verbatim, and names the two ways forward (build a
 * variant vs adopt the pack as-is).
 */
export const PACK_INSPIRATION_NOTE = [
  'These are patterns to adapt to your domain, not a layout to copy verbatim.',
  'To build a variant: create your own folders (via `write` or your editor) and reuse only the ideas that fit.',
  'To adopt this pack as-is: re-run without `--dry-run`.',
].join('\n');

/** The template names a folder ships: its starter plus any extras. */
function folderTemplateNames(folder: StarterFolder): string {
  return [folder.starterTemplate, ...(folder.extraTemplates ?? [])].join(', ');
}

/**
 * Render a pack's layout + rationale as plain text. Pure: depends only on the
 * passed `StarterPack`. Consumers add their own headers / coloring.
 */
export function formatPackRationale(pack: StarterPack): string {
  const lines: string[] = [
    `Pack: ${pack.name} — ${pack.description}`,
    '',
    PACK_INSPIRATION_NOTE,
    '',
  ];

  lines.push('Layout & rationale:');
  for (const folder of pack.folders) {
    lines.push(`  ${folder.path}/ — ${folder.title}`);
    lines.push(`    why: ${folder.description}`);
    lines.push(`    templates: ${folderTemplateNames(folder)}`);
  }

  const rootFiles = pack.rootFiles ? Object.keys(pack.rootFiles) : [];
  if (rootFiles.length > 0) {
    lines.push('', `Root files: ${rootFiles.join(', ')}`);
  }

  return lines.join('\n');
}
