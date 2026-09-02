import { z } from 'zod';
import { stripFrontmatter } from '../extensions/frontmatter.ts';

export const SkillCostTiersSchema = z
  .object({
    alwaysOn: z.number().int().nonnegative(),
    onTrigger: z.number().int().nonnegative(),
    onDemand: z.number().int().nonnegative(),
  })
  .strict();
export type SkillCostTiers = z.infer<typeof SkillCostTiersSchema>;

export interface SkillCostInput {
  name?: string | null;
  description?: string | null;
  skillMd: string;
  files: ReadonlyArray<{ relPath: string; content: string | null }>;
}

export const READABLE_SKILL_EXTENSIONS = ['.md', '.mdx', '.txt'] as const;

export const ALWAYS_ON_TOKEN_BUDGET = 100;
export const ON_TRIGGER_TOKEN_BUDGET = 5000;

const CHARS_PER_TOKEN = 4;

function estimateTokens(charCount: number): number {
  return Math.round(charCount / CHARS_PER_TOKEN);
}

function isReadableBundleFile(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return false;
  return (READABLE_SKILL_EXTENSIONS as readonly string[]).includes(
    relPath.slice(dot).toLowerCase(),
  );
}

export function estimateSkillCost(input: SkillCostInput): SkillCostTiers {
  const alwaysOn = estimateTokens((input.name ?? '').length + (input.description ?? '').length);
  const onTrigger = estimateTokens(stripFrontmatter(input.skillMd).body.length);

  const hasOverlayMirror = input.files.some((f) => f.relPath === 'overlay.yaml');

  let onDemandChars = 0;
  for (const file of input.files) {
    if (file.content === null) continue;
    if (file.relPath === 'SKILL.md') continue;
    if (hasOverlayMirror && file.relPath.startsWith('upstream/')) continue;
    if (!isReadableBundleFile(file.relPath)) continue;
    onDemandChars += file.content.length;
  }

  return { alwaysOn, onTrigger, onDemand: estimateTokens(onDemandChars) };
}
