import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { BASE16_SLOTS, type Base16Slot, containsNonWhitespace } from '../../theme/base16.ts';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const paletteShape = Object.fromEntries(
  BASE16_SLOTS.map((slot) => [slot, z.string().regex(HEX_COLOR_RE, 'must be a #rrggbb hex color')]),
) as Record<Base16Slot, z.ZodString>;

const Base16PaletteSchema = z.object(paletteShape);

const NonBlankMetadataStringSchema = z.string().min(1).refine(containsNonWhitespace, {
  message: 'must contain a non-whitespace character',
});

export const SavedThemeSchemeSchema = z
  .object({
    name: NonBlankMetadataStringSchema,
    author: NonBlankMetadataStringSchema.optional(),
    variant: z.enum(['dark', 'light']),
    palette: Base16PaletteSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeScheme = z.infer<typeof SavedThemeSchemeSchema>;

export const SavedThemeSaveRequestSchema = z
  .object({
    name: z.string().min(1),
    scheme: SavedThemeSchemeSchema,
    stem: z.string().min(1).optional(),
    extension: z.enum(['.yaml', '.yml']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeSaveRequest = z.infer<typeof SavedThemeSaveRequestSchema>;

export const SavedThemeSaveSuccessSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeSaveSuccess = z.infer<typeof SavedThemeSaveSuccessSchema>;

export const SavedThemeUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    scheme: SavedThemeSchemeSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeUpdateRequest = z.infer<typeof SavedThemeUpdateRequestSchema>;

export const SavedThemeUpdateSuccessSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeUpdateSuccess = z.infer<typeof SavedThemeUpdateSuccessSchema>;

export const SavedThemeDeleteSuccessSchema = z.discriminatedUnion('existed', [
  z.object({ existed: z.literal(false) }).loose(),
  z
    .object({
      existed: z.literal(true),
      filename: z.string().min(1),
      scheme: SavedThemeSchemeSchema,
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type SavedThemeDeleteSuccess = z.infer<typeof SavedThemeDeleteSuccessSchema>;

export const SavedThemeListEntrySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    id: z.string().min(1),
    filename: z.string().min(1),
    scheme: SavedThemeSchemeSchema,
  }),
  z.object({
    ok: z.literal(false),
    filename: z.string().min(1),
    id: z.string().min(1).optional(),
    code: z.string().min(1),
    conflictingFilenames: z.array(z.string().min(1)).min(2).optional(),
  }),
]) satisfies StandardSchemaV1;
export type SavedThemeListEntry = z.infer<typeof SavedThemeListEntrySchema>;

export const SavedThemesListSuccessSchema = z
  .object({
    themes: z.array(SavedThemeListEntrySchema),
    truncated: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemesListSuccess = z.infer<typeof SavedThemesListSuccessSchema>;
