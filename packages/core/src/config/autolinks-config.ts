import { z } from 'zod';

const AutolinkEntrySchema = z.object({
  prefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, {
    message: 'prefix must start with a letter and use only letters, digits, _ and -',
  }),
  url: z.string().regex(/^https?:\/\/[^\s<>]*<num>[^\s<>]*$/, {
    message: 'url must be an http or https URL containing <num>',
  }),
});

export const AutolinksSchema = z.array(AutolinkEntrySchema);

export const EffectiveAutolinkEntrySchema = AutolinkEntrySchema.nullable().catch(null);
