import { z } from 'zod';
import type { ConfigValidationError } from './errors.ts';
import type { ConfigPatch } from './schema.ts';
import { toConfigIssue } from './yaml-patch.ts';

const TrustedPrivateOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.hostname.includes('*');
  } catch {
    return false;
  }
}, 'Expected a canonical credential-free HTTPS origin: lowercase hostname, no default port, trailing slash, path, query, fragment or wildcard');

export const TrustedPrivateOriginsSchema = z.array(TrustedPrivateOriginSchema);
export const EffectiveTrustedPrivateOriginSchema =
  TrustedPrivateOriginSchema.nullable().catch(null);

const SkillSourcePatchSchema = z.looseObject({
  skills: z.looseObject({ trustedPrivateOrigins: TrustedPrivateOriginsSchema.nullish() }).nullish(),
});

export function validateSkillSourcePatch(
  patch: ConfigPatch,
): Extract<ConfigValidationError, { code: 'SCHEMA_INVALID' }> | null {
  const parsed = SkillSourcePatchSchema.safeParse(patch);
  return parsed.success
    ? null
    : { code: 'SCHEMA_INVALID', issues: parsed.error.issues.map(toConfigIssue) };
}
