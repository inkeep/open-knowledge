
import { z } from 'zod';
import { OK_DIR } from '../constants/ok-dir.ts';
import { skillStateFieldRegistry } from './field-registry.ts';

export const SKILL_STATE_FILENAME = 'skill-state.yml';

export const SKILL_STATE_REL = [OK_DIR, SKILL_STATE_FILENAME] as const;

export const SKILL_STATE_TARGETS = ['claude-cowork', 'cli-hosts'] as const;
export type SkillStateTarget = (typeof SKILL_STATE_TARGETS)[number];

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

export const SKILL_STATE_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

export const SKILL_STATE_SCHEMA_VERSION = 1;

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
});

export type SkillState = z.infer<typeof SkillStateSchema>;
export type SkillStateTargetEntry = z.infer<typeof TargetEntrySchema>;

export function emptySkillState(): SkillState {
  return {
    schema: SKILL_STATE_SCHEMA_VERSION,
    targets: {},
  };
}
