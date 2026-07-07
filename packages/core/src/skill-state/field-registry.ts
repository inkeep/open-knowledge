import { z } from 'zod';

interface SkillStateFieldMeta {
  /** Optional human-readable description; renders into IDE hover or future export. */
  description?: string;
}

// Symbol-keyed globalThis singleton — same discipline as `config/field-registry.ts`.
// Two copies of this module loaded under different file paths still share one
// registry of registered schemas.
const SINGLETON_KEY = Symbol.for('@inkeep/open-knowledge/skill-state-field-registry');

interface SingletonGlobal {
  [SINGLETON_KEY]?: z.core.$ZodRegistry<SkillStateFieldMeta>;
}

const g = globalThis as SingletonGlobal;
if (g[SINGLETON_KEY] === undefined) {
  g[SINGLETON_KEY] = z.registry<SkillStateFieldMeta>();
}

export const skillStateFieldRegistry: z.core.$ZodRegistry<SkillStateFieldMeta> = g[SINGLETON_KEY];
