import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../constants/cc1.ts';
import { OK_DIR } from '../constants/ok-dir.ts';

export const INSTALLED_SKILLS_FILENAME = 'installed-skills.json';

export const INSTALLED_SKILLS_REL = [OK_DIR, 'local', INSTALLED_SKILLS_FILENAME] as const;

export const INSTALLED_SKILLS_SCHEMA_VERSION = 1;

/** Skill scope — mirrors the MCP skill-target scope (project store vs user store).
 *  Derived from the canonical `MANAGED_ARTIFACT_SCOPES` (cc1.ts) — do not
 *  re-declare the tuple. */
export const InstalledSkillScopeSchema = z.enum(MANAGED_ARTIFACT_SCOPES);
export type InstalledSkillScope = z.infer<typeof InstalledSkillScopeSchema>;

export const InstalledSkillEntrySchema = z.looseObject({
  hosts: z.array(z.string()),
  scope: InstalledSkillScopeSchema,
  scripts: z.boolean(),
  installedAt: z.iso.datetime(),
});
export type InstalledSkillEntry = z.infer<typeof InstalledSkillEntrySchema>;

export const InstalledSkillsSchema = z.looseObject({
  schema: z.literal(INSTALLED_SKILLS_SCHEMA_VERSION),
  skills: z.record(z.string(), InstalledSkillEntrySchema).default({}),
});
export type InstalledSkills = z.infer<typeof InstalledSkillsSchema>;

export function emptyInstalledSkills(): InstalledSkills {
  return { schema: INSTALLED_SKILLS_SCHEMA_VERSION, skills: {} };
}

export function parseInstalledSkills(raw: string): InstalledSkills | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = InstalledSkillsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
