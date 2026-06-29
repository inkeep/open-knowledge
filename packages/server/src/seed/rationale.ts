
import type { StarterFolder, StarterPack } from './starter.ts';

export const PACK_INSPIRATION_NOTE = [
  'These are patterns to adapt to your domain, not a layout to copy verbatim.',
  'To build a variant: create your own folders (via `write` or your editor) and reuse only the ideas that fit.',
  'To adopt this pack as-is: re-run without `--dry-run`.',
].join('\n');

function folderTemplateNames(folder: StarterFolder): string {
  return [folder.starterTemplate, ...(folder.extraTemplates ?? [])].join(', ');
}

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
