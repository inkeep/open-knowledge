/**
 * Zod schema for `~/.ok/skill-state.yml`.
 *
 * Single user-global YAML file describing the install-state of each
 * actively-gated skill target. Replaces the previous subdir-of-plain-files
 * mechanism (`~/.ok/skill-state/<target>`).
 *
 * Two actively-written targets at v0:
 *   - `claude-cowork` — Track 2: `.skill` zip + Claude Desktop manual upload
 *   - `cli-hosts`     — Track 1: `npx skills add --agent '*' -g`
 *
 * Per-target metadata at v0:
 *   - `version`     — semver-ish string (regex-validated)
 *   - `recordedAt`  — ISO 8601 timestamp; updated on EVERY successful write,
 *                     including reinstalls of the same version (preserves
 *                     today's mtime-update semantic; in-band so the YAML
 *                     file's own mtime is no longer authoritative)
 *   - `surface`     — optional install-source attribution. Vocabulary
 *                     mirrors the existing `surface` enum in
 *                     `~/.ok/skill-install-events.jsonl`. New value
 *                     `desktop-direct` covers the path where desktop
 *                     main-process boot invokes `installUserSkill`
 *                     directly without going through `buildAndOpenSkill`.
 *
 * Schema versioning: `schema: 1` envelope. Additive changes (new optional
 * fields, new target keys, new enum values) stay at v1. Breaking shape
 * changes bump to `schema: 2` with a one-shot migrator.
 */

import { z } from 'zod';
import { OK_DIR } from '../constants/ok-dir.ts';
import { skillStateFieldRegistry } from './field-registry.ts';

/** Filename of the user-global skill-state file under `.ok/`. */
export const SKILL_STATE_FILENAME = 'skill-state.yml';

/** Path segments relative to `$HOME` for the file. */
export const SKILL_STATE_REL = [OK_DIR, SKILL_STATE_FILENAME] as const;

/**
 * Actively-written install-state targets at v0. Adding a target means
 * appending to this tuple and writing/reading the new key at the right
 * call site — schema-additive on both the YAML and the GET response.
 */
export const SKILL_STATE_TARGETS = ['claude-cowork', 'cli-hosts'] as const;
export type SkillStateTarget = (typeof SKILL_STATE_TARGETS)[number];

/**
 * Install-source attribution. Field name + first three values mirror the
 * existing `surface` enum in `~/.ok/skill-install-events.jsonl` so readers
 * across the event log and the state file see one vocabulary. Fourth value
 * `desktop-direct` captures the path where desktop main-process boot invokes
 * `installUserSkill` directly (not via `buildAndOpenSkill`). Fifth value
 * `cli-start` is the CLI's `ok start` / `ok repair-skills` automated sweep —
 * sibling of `desktop-direct` but for the npm-installed CLI invocation paths.
 */
export type SkillStateSurface =
  | 'server-build-and-open'
  | 'electron-build-and-open'
  | 'cli-npx-skills-add'
  | 'desktop-direct'
  | 'cli-start';

export const SKILL_STATE_SURFACES: ReadonlyArray<SkillStateSurface> = [
  'server-build-and-open',
  'electron-build-and-open',
  'cli-npx-skills-add',
  'desktop-direct',
  'cli-start',
];

/**
 * Plain semver-ish string the per-target `version` field is allowed to hold.
 * Empty / malformed content reads as `null` (treated as "fresh install").
 */
export const SKILL_STATE_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * Schema major version. Increment on breaking shape changes; pair with a
 * one-shot migrator that reads `schema: <N-1>` and writes `schema: <N>`.
 *
 * v1: initial promotion from `~/.ok/skill-state/<target>` plain files.
 */
export const SKILL_STATE_SCHEMA_VERSION = 1;

/** Per-target entry. Each leaf calls `.register()` BEFORE wrappers per Zod v4 metadata-binding rules. */
const TargetEntrySchema = z.looseObject({
  version: z
    .string()
    .regex(SKILL_STATE_VERSION_RE, 'version must match /^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$/')
    .register(skillStateFieldRegistry, {
      description: 'Recorded skill version for this target.',
    }),
  recordedAt: z.iso.datetime().register(skillStateFieldRegistry, {
    description:
      'ISO 8601 timestamp of the most recent successful write. Updated on every write, including reinstalls of the same version.',
  }),
  surface: z
    .enum(SKILL_STATE_SURFACES as readonly [SkillStateSurface, ...SkillStateSurface[]])
    .register(skillStateFieldRegistry, {
      description: 'Install-source surface that recorded this entry.',
    })
    .optional(),
});

/**
 * Per-bundle opt-in decision. Keyed by a bundle's install NAME (e.g.
 * `open-knowledge-discovery`), NOT the install target. `enabled: false` is an
 * explicit decline recorded via the first-launch consent dialog or `ok init
 * --no-skills`; an absent key means "no recorded decision" (grandfather: the
 * gate falls back to disk presence). Each leaf `.register()` BEFORE wrappers
 * per the Zod v4 metadata-binding rule.
 */
const BundleDecisionEntrySchema = z.looseObject({
  enabled: z.boolean().register(skillStateFieldRegistry, {
    description: 'Whether this user-global skill bundle is opted in.',
  }),
  decidedAt: z.iso.datetime().register(skillStateFieldRegistry, {
    description: 'ISO 8601 timestamp of the opt-in / opt-out decision.',
  }),
});

/**
 * Top-level schema. `looseObject` everywhere for forward-compat: a future
 * version can add target keys or per-entry fields without breaking older
 * readers (they project the known shape; unknown keys pass through).
 */
export const SkillStateSchema = z.looseObject({
  schema: z.literal(SKILL_STATE_SCHEMA_VERSION).register(skillStateFieldRegistry, {
    description: 'Schema major version. Bumped only on breaking shape changes.',
  }),
  targets: z
    .looseObject({
      'claude-cowork': TargetEntrySchema.optional(),
      'cli-hosts': TargetEntrySchema.optional(),
    })
    .register(skillStateFieldRegistry, {
      description: 'Per-target install-state entries. Absent target = no recorded install.',
    })
    .default({}),
  bundles: z
    .record(z.string(), BundleDecisionEntrySchema)
    .register(skillStateFieldRegistry, {
      description:
        'Per-bundle opt-in decisions keyed by install name. Absent key = no recorded decision.',
    })
    .optional(),
});

export type SkillState = z.infer<typeof SkillStateSchema>;
export type SkillStateTargetEntry = z.infer<typeof TargetEntrySchema>;
export type SkillStateBundleEntry = z.infer<typeof BundleDecisionEntrySchema>;

/**
 * The single per-bundle enablement policy, kept pure (no disk) so it's
 * trivially testable and shared by every install actor (desktop reclaim, CLI
 * sweep, `ok init`, dialog confirm). Explicit recorded decision wins; an
 * unrecorded bundle grandfathers to whatever is on disk (existing install
 * stays, truly-fresh machine stays uninstalled until the dialog / `ok init`
 * records a decision). Lives in core so the desktop module can reach it
 * without importing the server package.
 */
export function resolveBundleEnabled(
  decision: boolean | null,
  opts: { installedOnDisk: boolean },
): boolean {
  return decision ?? opts.installedOnDisk;
}

/**
 * Build an empty `SkillState` document with a current schema version. Used
 * by writers that need to materialize a fresh document when no file exists.
 */
export function emptySkillState(): SkillState {
  return {
    schema: SKILL_STATE_SCHEMA_VERSION,
    targets: {},
  };
}
