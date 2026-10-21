import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

const DOC_NOTICE_SIDES = ['ours', 'theirs'] as const;
const DOC_NOTICE_MOVE_REASONS = [
  'check-failed',
  'too-large',
  'conflict-markers',
  'no-base',
  'no-merge-engine',
  'outside-settings-applied',
  'outside-settings-invalid',
] as const;
const DOC_NOTICE_HOLD_CAUSES = [
  'no-history-or-backup',
  'keeps-changing',
  'not-utf8',
  'unreadable',
] as const;

const DocNoticeKeptBlocksSchema = z.object({
  duplicated: z.number().int().nonnegative(),
  restoredDeletedHere: z.number().int().nonnegative(),
  restoredDeletedOutside: z.number().int().nonnegative(),
});

const docNoticeCommon = {
  id: z.string().min(1),
  docName: z.string().min(1),
  file: z.string().min(1),
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
  events: z.number().int().positive(),
  entries: z.array(z.string().min(1)),
};

export const DocNoticeWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...docNoticeCommon,
      kind: z.literal('both-kept'),
      kept: DocNoticeKeptBlocksSchema,
    })
    .loose(),
  z
    .object({
      ...docNoticeCommon,
      kind: z.literal('moved-to-history'),
      side: z.enum(DOC_NOTICE_SIDES),
      reason: z.enum(DOC_NOTICE_MOVE_REASONS),
    })
    .loose(),
  z
    .object({
      ...docNoticeCommon,
      kind: z.literal('moved-to-backup'),
      side: z.enum(DOC_NOTICE_SIDES),
      reason: z.enum(DOC_NOTICE_MOVE_REASONS),
      backup: z.string().min(1),
    })
    .loose(),
  z
    .object({
      ...docNoticeCommon,
      kind: z.literal('save-held'),
      cause: z.enum(DOC_NOTICE_HOLD_CAUSES),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type DocNoticeWire = z.infer<typeof DocNoticeWireSchema>;

export const DocNoticesSuccessSchema = z
  .object({
    notices: z.array(DocNoticeWireSchema),
  })
  .loose() satisfies StandardSchemaV1;

export const DismissDocNoticeRequestSchema = z
  .object({
    docName: z.string().min(1),
    id: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;

export const DismissDocNoticeSuccessSchema = z
  .object({
    dismissed: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
