/**
 * Saved-theme store routes (`GET /api/saved-themes`, `POST`/`PUT`/`DELETE /api/saved-theme`).
 *
 * The store is a user-global folder of Tinted Theming scheme files; the renderer
 * cannot write it directly, so save/update/delete/list are server operations. These are
 * the wire schemas both sides share.
 *
 * Two bars, deliberately different: the LIST response mirrors the store's
 * permissive total read — a scheme file that failed to parse (or whose name
 * can't become an id) still appears, as a `{ ok: false, code }` warning entry,
 * so the user can see and fix it. The SAVE request is the strict write validator
 * — `SavedThemeSchemeSchema` requires all sixteen slots as `#rrggbb`, so a
 * malformed palette is refused at the wire boundary before anything is written.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { BASE16_SLOTS, type Base16Slot, containsNonWhitespace } from '../../theme/base16.ts';

/** A single palette slot: a `#rrggbb` hex color. The canonical form the editor's
 *  color picker emits; the strict write path requires it (the permissive read
 *  parser also accepts bare/legacy forms, which is the point of the two bars). */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * The sixteen-slot palette, every slot required. Built from `BASE16_SLOTS` so
 * the wire shape can't drift from the format. The cast asserts what the const
 * array makes structurally true — a keyed `Record<Base16Slot, …>` shape — so the
 * inferred palette type is precise (`{ base00: string; … }`) rather than a loose
 * index signature.
 */
const paletteShape = Object.fromEntries(
  BASE16_SLOTS.map((slot) => [slot, z.string().regex(HEX_COLOR_RE, 'must be a #rrggbb hex color')]),
) as Record<Base16Slot, z.ZodString>;

const Base16PaletteSchema = z.object(paletteShape);

const NonBlankMetadataStringSchema = z.string().min(1).refine(containsNonWhitespace, {
  message: 'must contain a non-whitespace character',
});

/**
 * A complete base16 scheme as the save path accepts and the list path returns.
 * `.loose()` tolerates extra top-level fields for forward-compat; the serializer
 * only emits the standard fields, so nothing proprietary can ride into the file.
 */
export const SavedThemeSchemeSchema = z
  .object({
    name: NonBlankMetadataStringSchema,
    author: NonBlankMetadataStringSchema.optional(),
    variant: z.enum(['dark', 'light']),
    palette: Base16PaletteSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeScheme = z.infer<typeof SavedThemeSchemeSchema>;

/**
 * Request body for `POST /api/saved-theme`. `name` is the human-facing display
 * name; the handler derives a safe filename stem and palette id from it and
 * refuses a taken identity. `stem` is reserved for restoring a just-deleted
 * file under its exact prior identity. `scheme` is the palette to write.
 */
export const SavedThemeSaveRequestSchema = z
  .object({
    name: z.string().min(1),
    scheme: SavedThemeSchemeSchema,
    /** Exact prior filename stem, used only by the delete-undo restore path. */
    stem: z.string().min(1).optional(),
    /** Preserve a hand-dropped `.yml` filename when restoring after delete. */
    extension: z.enum(['.yaml', '.yml']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeSaveRequest = z.infer<typeof SavedThemeSaveRequestSchema>;

/** Success body for `POST /api/saved-theme`. `id` is the namespaced palette id
 *  the config fields reference; `filename` is the file written (the stable
 *  edit/delete target). */
export const SavedThemeSaveSuccessSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeSaveSuccess = z.infer<typeof SavedThemeSaveSuccessSchema>;

/**
 * Request body for `PUT /api/saved-theme`. The immutable saved-theme id picks
 * an existing file; the complete scheme replaces its contents. Full-state
 * replacement makes retries idempotent and keeps partial client state from
 * leaking into the user-owned base16 file.
 */
export const SavedThemeUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    scheme: SavedThemeSchemeSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeUpdateRequest = z.infer<typeof SavedThemeUpdateRequestSchema>;

/** Success body for `PUT /api/saved-theme`. The filename is the same file that
 *  existed before the update; update never creates a missing theme. */
export const SavedThemeUpdateSuccessSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemeUpdateSuccess = z.infer<typeof SavedThemeUpdateSuccessSchema>;

/** Success body for `DELETE /api/saved-theme?id=<id>`. A real deletion returns
 *  the exact parsed scheme so the renderer can offer a time-boxed undo without
 *  retaining a server-side backup. An absent id is an idempotent no-op. */
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

/**
 * One entry in the list response, discriminated on `ok`. A usable theme carries
 * its palette so the picker can render a preview; an unusable one carries a
 * machine-readable `code` (a parse failure or an id-derivation failure) and is
 * listed rather than hidden. `code` is a plain string, not a closed enum, so a
 * new failure kind in the store never breaks older clients — the UI maps known
 * codes to copy and shows the raw code otherwise.
 */
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

/**
 * Success body for `GET /api/saved-themes`. `truncated` is `true` when the store
 * held more scheme files than the scan cap listed — surfaced so the UI can tell
 * the user the list is incomplete rather than silently cutting it.
 */
export const SavedThemesListSuccessSchema = z
  .object({
    themes: z.array(SavedThemeListEntrySchema),
    truncated: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type SavedThemesListSuccess = z.infer<typeof SavedThemesListSuccessSchema>;
