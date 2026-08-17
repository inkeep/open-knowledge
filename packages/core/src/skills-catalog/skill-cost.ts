/**
 * Shared three-tier context-cost estimator for a skill bundle.
 *
 * One input contract (frontmatter name/description plus the bundle's named
 * blobs), one output (three tiers), fed by two producers that already hold the
 * bytes — the preview payload on the client and the bundle walk on the server —
 * so a skill's cost reads the same everywhere it is shown.
 */
import { z } from 'zod';
import { stripFrontmatter } from '../extensions/frontmatter.ts';

/**
 * A skill's context cost in estimated tokens, split by when the cost is paid.
 * There is deliberately no summed total: a single figure misranks skills whose
 * weight sits in different tiers (a lean index in front of a heavy body vs. the
 * reverse), so every surface renders the three tiers or a documented subset.
 *
 * The zod schema is the single source both the estimator's return type and the
 * skills-list wire field derive from, so the shape cannot drift between the
 * producer and the transport.
 */
export const SkillCostTiersSchema = z
  .object({
    /** `name` + `description` — the only fields a harness keeps in context until the skill triggers. */
    alwaysOn: z.number().int().nonnegative(),
    /** SKILL.md body after frontmatter — loaded when the skill fires. */
    onTrigger: z.number().int().nonnegative(),
    /** Readable bundle files beyond SKILL.md — loaded only when the agent opens one. */
    onDemand: z.number().int().nonnegative(),
  })
  .strict();
export type SkillCostTiers = z.infer<typeof SkillCostTiersSchema>;

/** Input the estimator needs; `SkillPreview` satisfies it structurally so the client passes its payload verbatim. */
export interface SkillCostInput {
  name?: string | null;
  description?: string | null;
  /** Full SKILL.md text (frontmatter + body); the frontmatter is stripped for the on-trigger tier. */
  skillMd: string;
  /** Bundle files — `content` is null for binary/unreadable files. SKILL.md, if present here, is excluded from on-demand. */
  files: ReadonlyArray<{ relPath: string; content: string | null }>;
}

/**
 * Bundle files whose bytes a harness may read into context on demand. Scripts,
 * `overlay.yaml` and `evals/*.json` are executed or consumed as data, never read
 * as prose — counting them overstates on-demand cost by up to ~7.5k tokens on
 * real bundles, so on-demand counts by readable extension anywhere in the bundle,
 * not by a `references/` directory name.
 */
export const READABLE_SKILL_EXTENSIONS = ['.md', '.mdx', '.txt'] as const;

/** Published always-on norm from the Agent Skills spec (~100 tokens/skill, name + description). */
export const ALWAYS_ON_TOKEN_BUDGET = 100;
/** Published on-trigger norm from the Agent Skills spec (keep the SKILL.md body under ~5k tokens). */
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

/**
 * Estimate a skill's three-tier context cost from the bytes a producer already
 * holds. `chars / 4`, no tokenizer: consistent under one method, so figures
 * compare like-for-like even though none is exact against a real tokenizer
 * (hence the `~` every surface prefixes).
 */
export function estimateSkillCost(input: SkillCostInput): SkillCostTiers {
  const alwaysOn = estimateTokens((input.name ?? '').length + (input.description ?? '').length);
  const onTrigger = estimateTokens(stripFrontmatter(input.skillMd).body.length);

  let onDemandChars = 0;
  for (const file of input.files) {
    if (file.content === null) continue;
    if (file.relPath === 'SKILL.md') continue;
    if (!isReadableBundleFile(file.relPath)) continue;
    onDemandChars += file.content.length;
  }

  return { alwaysOn, onTrigger, onDemand: estimateTokens(onDemandChars) };
}
