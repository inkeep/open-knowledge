/**
 * Schema for the per-project installed-skills marker at
 * `<projectDir>/.ok/local/installed-skills.json`.
 *
 * This is the persisted record of which skills OK has projected into which
 * editor host dirs for this project — the snapshot reclaim re-materializes
 * from, the set `getOkArtifactPaths` makes the sharing-mode exclude
 * skill-aware against, and the source of truth for
 * reverse-projection on uninstall/delete.
 *
 * Lives under `.ok/local/` — per-machine runtime state, gitignored (NOT
 * committed), parallel to `server.lock` / `state.json`. Each machine records
 * what IT installed; a teammate's reclaim populates their own marker on clone.
 *
 * JSON (not YAML) to match the sibling `.ok/local/*.json` runtime files.
 * `looseObject` everywhere for forward-compat — a future field or skill key
 * passes through older readers untouched.
 */

import { z } from 'zod';
import { MANAGED_ARTIFACT_SCOPES } from '../constants/cc1.ts';
import { OK_DIR } from '../constants/ok-dir.ts';

/** Filename of the per-project installed-skills marker under `.ok/local/`. */
export const INSTALLED_SKILLS_FILENAME = 'installed-skills.json';

/** Path segments relative to the project root for the marker file. */
export const INSTALLED_SKILLS_REL = [OK_DIR, 'local', INSTALLED_SKILLS_FILENAME] as const;

/**
 * Schema major version. Bump only on breaking shape changes, paired with a
 * one-shot migrator.
 */
export const INSTALLED_SKILLS_SCHEMA_VERSION = 1;

/** Skill scope — mirrors the MCP skill-target scope (project store vs user store).
 *  Derived from the canonical `MANAGED_ARTIFACT_SCOPES` (cc1.ts) — do not
 *  re-declare the tuple. */
export const InstalledSkillScopeSchema = z.enum(MANAGED_ARTIFACT_SCOPES);
export type InstalledSkillScope = z.infer<typeof InstalledSkillScopeSchema>;

/**
 * One installed skill's record. `hosts` are the editor ids the skill was
 * installed into (e.g. `claude` → a `.claude/skills/<name>` symlink). Install
 * is a symlink to the `.ok/skills/<name>` source, so there is no copied
 * snapshot to drift — install state is the on-disk symlink reality, and this
 * marker is a cache (the sharing-mode exclude + a fast read; truth is
 * detection). `scripts` flags a skill that ships executable `scripts/` (OF5 —
 * surfaced so the sharing/commit path can warn).
 *
 * `looseObject` so a marker written by an older OK (which still carried a
 * `contentHash` field) parses unchanged.
 */
export const InstalledSkillEntrySchema = z.looseObject({
  hosts: z.array(z.string()),
  scope: InstalledSkillScopeSchema,
  scripts: z.boolean(),
  installedAt: z.iso.datetime(),
});
export type InstalledSkillEntry = z.infer<typeof InstalledSkillEntrySchema>;

/**
 * Top-level marker shape. `skills` keys by skill name. `looseObject` so a
 * future version can add fields/keys without breaking older readers.
 */
export const InstalledSkillsSchema = z.looseObject({
  schema: z.literal(INSTALLED_SKILLS_SCHEMA_VERSION),
  skills: z.record(z.string(), InstalledSkillEntrySchema).default({}),
});
export type InstalledSkills = z.infer<typeof InstalledSkillsSchema>;

/** A fresh, empty marker document at the current schema version. */
export function emptyInstalledSkills(): InstalledSkills {
  return { schema: INSTALLED_SKILLS_SCHEMA_VERSION, skills: {} };
}

/**
 * Parse + validate raw marker JSON. Returns `null` on parse error or schema
 * violation (fail-soft — a corrupt marker is treated as "nothing installed"
 * rather than throwing, so a bad file never breaks sharing-mode or reclaim).
 * Shared by the server writer and the CLI `getOkArtifactPaths` reader so both
 * sides validate identically.
 */
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
