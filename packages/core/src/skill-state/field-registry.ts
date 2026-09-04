import { z } from 'zod';

interface SkillStateFieldMeta {
  description?: string;
}

const SINGLETON_KEY = Symbol.for('@inkeep/open-knowledge/skill-state-field-registry');

interface SingletonGlobal {
  [SINGLETON_KEY]?: z.core.$ZodRegistry<SkillStateFieldMeta>;
}

const g = globalThis as SingletonGlobal;
if (g[SINGLETON_KEY] === undefined) {
  g[SINGLETON_KEY] = z.registry<SkillStateFieldMeta>();
}

export const skillStateFieldRegistry: z.core.$ZodRegistry<SkillStateFieldMeta> = g[SINGLETON_KEY];
