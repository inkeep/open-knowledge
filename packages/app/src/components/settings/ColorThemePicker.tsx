import { useLingui } from '@lingui/react/macro';
import { CircleAlert, Moon, Pencil, Plus, Sun, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  base16ToTokens,
  COLOR_THEMES,
  type ColorTheme,
  type ColorThemeSelection,
  defaultThemeTokens,
  resolveCustomScheme,
} from '@/lib/color-themes';
import { cn } from '@/lib/utils';

type SeedInput = Record<string, unknown> | undefined;

interface UnavailableColorTheme {
  key: string;
  label: string;
  problem: string;
  detail: string;
}

interface ColorThemeEditControl {
  /** The user-owned saved themes that expose the editor toggle. */
  themeIds: readonly string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface ColorThemeDeleteControl {
  themeIds: readonly string[];
  onDelete: (id: string) => boolean | undefined | Promise<boolean | undefined>;
}

interface ColorThemeCreateControl {
  onCreate: () => void;
}

export interface ColorThemePickerProps {
  /** The palette assigned to each mode (`appearance.colorThemeLight` / `…Dark`). */
  selection: ColorThemeSelection;
  /**
   * The palettes to render as tiles, in order. Defaults to the built-in
   * registry; the settings surface passes the built-ins plus the user's saved
   * themes, which are ordinary `ColorTheme`s and so render identically.
   */
  themes?: readonly ColorTheme[];
  /** Saved files that exist but cannot provide a usable palette. */
  unavailableThemes?: readonly UnavailableColorTheme[];
  /** Fired with the mode slot and the theme id when a tile's sun/moon is pressed.
   *  The id is any shape-valid theme id — a built-in's or a saved theme's. */
  onAssign: (slot: 'light' | 'dark', id: string) => void;
  /** Optional editor binding shown only on the theme ids declared here. */
  editControl?: ColorThemeEditControl;
  /** Optional destructive action shown only for the user-owned ids declared here. */
  deleteControl?: ColorThemeDeleteControl;
  /** Optional gallery tile that starts the saved-theme creation flow. */
  createControl?: ColorThemeCreateControl;
  /**
   * The mode on screen right now — the one `appearance.theme` resolves to. Rings
   * the tile currently in effect, and paints the Default tile: that tile has no
   * palette of its own, so it advertises the base stylesheet in the live mode.
   */
  slotMode?: 'light' | 'dark';
  /** The user's custom-theme scheme (partial), used to paint the Custom tile preview. */
  customSeed?: SeedInput;
  /**
   * The form label's `htmlFor` target. It lands on the first sun toggle, not on
   * the grid root: a `<fieldset>` is not a labelable element, so `<label for>`
   * pointing at it would never move focus. Same treatment the enum-toggle
   * control gives its first ToggleGroupItem.
   */
  firstItemId?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/** The handful of palette colors a preview tile renders. */
interface SwatchColors {
  chrome: string;
  surface: string;
  bar: string;
  line: string;
  dots: [string, string, string];
}

function swatchFromTokens(t: Record<string, string>): SwatchColors {
  return {
    chrome: t.sidebar,
    surface: t.background,
    bar: t.primary,
    line: t.border,
    dots: [t['syntax-string'], t['syntax-keyword'], t['syntax-atom']],
  };
}

function swatchColors(
  theme: ColorTheme,
  customSeed: SeedInput,
  slotMode: 'light' | 'dark',
): SwatchColors {
  if (theme.id === 'custom') {
    return swatchFromTokens(base16ToTokens(resolveCustomScheme(customSeed)));
  }
  if (!theme.scheme) {
    // `default` has no authored palette — it IS the base stylesheet. Reading the
    // cascaded `var(--…)` here would inherit whichever palette is currently
    // applied to `<html>`, so paint the base tokens as literals instead.
    return swatchFromTokens(defaultThemeTokens(slotMode));
  }
  return swatchFromTokens(base16ToTokens(theme.scheme));
}

/** A miniature editor-window preview, à la the Vivaldi theme tiles. */
function ThemeSwatch({
  theme,
  customSeed,
  slotMode,
}: {
  theme: ColorTheme;
  customSeed: SeedInput;
  slotMode: 'light' | 'dark';
}) {
  const c = swatchColors(theme, customSeed, slotMode);
  return (
    <div
      aria-hidden
      data-theme-swatch=""
      className="aspect-[4/3] w-full overflow-hidden rounded-md border"
      style={{ backgroundColor: c.surface, borderColor: c.line }}
    >
      {/* Title bar: accent pill + a faux address field. */}
      <div
        className="flex h-1/3 items-center gap-1 px-1.5"
        style={{ backgroundColor: c.chrome, borderBottom: `1px solid ${c.line}` }}
      >
        <span className="h-1.5 w-5 rounded-full" style={{ backgroundColor: c.bar }} />
        <span
          className="h-1.5 flex-1 rounded-full opacity-50"
          style={{ backgroundColor: c.line }}
        />
      </div>
      {/* Body: a sidebar rail of dots + content accents. */}
      <div className="flex h-2/3">
        <div
          className="flex w-1/4 flex-col items-center justify-center gap-1"
          style={{ backgroundColor: c.chrome, borderRight: `1px solid ${c.line}` }}
        >
          {c.dots.map((dot, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative swatch dots
              key={i}
              className="size-1.5 rounded-full"
              style={{ backgroundColor: dot }}
            />
          ))}
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1 px-1.5">
          <span className="h-1.5 w-3/4 rounded-full" style={{ backgroundColor: c.dots[1] }} />
          <span
            className="h-1.5 w-1/2 rounded-full opacity-60"
            style={{ backgroundColor: c.line }}
          />
          <span className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: c.dots[0] }} />
        </div>
      </div>
    </div>
  );
}

/**
 * A slot icon has to read as on/off at a glance across every palette — it sits
 * on the tile, so the surrounding color is whatever scheme that tile previews.
 * The shadcn Toggle's stock pressed state is a `bg-muted` wash, which against a
 * themed tile is close to invisible; an accent ring plus a filled, accent-tinted
 * glyph survives any background.
 */
function slotToggleClass(pressed: boolean): string {
  return cn(
    'size-6 min-w-6 rounded-md border p-0 transition-colors',
    pressed
      ? 'border-primary bg-primary/15 text-primary hover:bg-primary/20 data-[state=on]:bg-primary/15'
      : 'border-border/70 text-muted-foreground/70 hover:text-foreground',
  );
}

function slotIconClass(pressed: boolean): string {
  return cn('size-3.5', pressed && 'fill-current');
}

/**
 * Tile grid for the light/dark palette pair. Every tile carries a sun and a
 * moon, so a palette can be the light theme, the dark theme, or both — which is
 * also why the grid is not a radio group: the two assignments are independent
 * single-selects that happen to share a row of tiles.
 *
 * Pressing the icon for the mode you are NOT currently in changes nothing on
 * screen by design, so the icon's own on/off state is the only feedback that
 * the assignment landed — it has to be unmistakable.
 *
 * Pressing an already-pressed icon is ignored rather than clearing the slot.
 * Each mode must resolve to some palette, and "none" is spelled `default`,
 * which is a tile of its own.
 */
export function ColorThemePicker({
  selection,
  themes = COLOR_THEMES,
  unavailableThemes = [],
  onAssign,
  editControl,
  deleteControl,
  createControl,
  slotMode = 'light',
  customSeed,
  firstItemId,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
}: ColorThemePickerProps) {
  const { t } = useLingui();
  return (
    // `fieldset` rather than a div: the grid is a set of related controls, and
    // the UA border/padding are reset by the utilities below.
    <fieldset
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedby}
      className="grid w-full min-w-0 grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {themes.map((theme, index) => {
        const isLight = selection.light === theme.id;
        const isDark = selection.dark === theme.id;
        const isEditable = editControl?.themeIds.includes(theme.id) ?? false;
        const isDeletable = deleteControl?.themeIds.includes(theme.id) ?? false;
        const isEditing = editControl?.selectedId === theme.id;
        const activeModeLabel =
          slotMode === 'light'
            ? t`Use ${theme.label} for the active light mode`
            : t`Use ${theme.label} for the active dark mode`;
        return (
          <fieldset
            key={theme.id}
            aria-label={theme.label}
            className={cn(
              'relative flex min-w-0 flex-col gap-1.5 rounded-lg border-2 p-1 text-left',
              selection[slotMode] === theme.id ? 'border-primary' : 'border-transparent',
            )}
          >
            <Button
              type="button"
              variant="ghost"
              aria-label={activeModeLabel}
              data-theme-focus-target=""
              onClick={() => onAssign(slotMode, theme.id)}
              className="h-auto w-full cursor-pointer p-0 transition-opacity hover:bg-transparent hover:opacity-90"
            >
              <ThemeSwatch theme={theme} customSeed={customSeed} slotMode={slotMode} />
            </Button>
            {isDeletable ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={t`Delete ${theme.label}`}
                aria-label={t`Delete ${theme.label}`}
                className="absolute top-2 end-2 z-10 border-border/80 bg-background/85 text-muted-foreground shadow-sm backdrop-blur-sm hover:border-destructive/50 hover:bg-destructive/15 hover:text-destructive focus-visible:border-destructive/50 focus-visible:text-destructive focus-visible:ring-destructive/20 dark:bg-background/80 dark:hover:bg-destructive/20"
                onClick={async (event) => {
                  const tile = event.currentTarget.closest('fieldset');
                  const focusTarget =
                    tile?.previousElementSibling?.querySelector<HTMLButtonElement>(
                      '[data-theme-focus-target]',
                    ) ??
                    tile?.nextElementSibling?.querySelector<HTMLButtonElement>(
                      '[data-theme-focus-target]',
                    );
                  const deleted = await deleteControl?.onDelete(theme.id);
                  if (deleted !== false) focusTarget?.focus();
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
            <div className="flex items-center justify-between gap-1 px-0.5">
              <span className="truncate text-1sm font-medium text-foreground">{theme.label}</span>
              <div className="flex shrink-0 items-center gap-1">
                {isEditable ? (
                  <Toggle
                    className={slotToggleClass(isEditing)}
                    pressed={isEditing}
                    onPressedChange={(pressed) => {
                      editControl?.onSelect(pressed ? theme.id : null);
                    }}
                    aria-label={isEditing ? t`Hide ${theme.label} editor` : t`Edit ${theme.label}`}
                  >
                    <Pencil className="size-3.5" />
                  </Toggle>
                ) : null}
                <Toggle
                  id={index === 0 ? firstItemId : undefined}
                  className={slotToggleClass(isLight)}
                  pressed={isLight}
                  onPressedChange={(pressed) => {
                    if (pressed) onAssign('light', theme.id);
                  }}
                  aria-label={t`Use ${theme.label} as the light theme`}
                >
                  <Sun className={slotIconClass(isLight)} />
                </Toggle>
                <Toggle
                  className={slotToggleClass(isDark)}
                  pressed={isDark}
                  onPressedChange={(pressed) => {
                    if (pressed) onAssign('dark', theme.id);
                  }}
                  aria-label={t`Use ${theme.label} as the dark theme`}
                >
                  <Moon className={slotIconClass(isDark)} />
                </Toggle>
              </div>
            </div>
          </fieldset>
        );
      })}
      {createControl ? (
        <Button
          type="button"
          variant="ghost"
          onClick={createControl.onCreate}
          className="group h-auto min-w-0 flex-col items-stretch gap-1.5 rounded-lg border-2 border-transparent p-1 text-left text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          <span className="flex aspect-[4/3] w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/10 transition-colors group-hover:border-foreground/40">
            <Plus aria-hidden className="size-6" />
          </span>
          <span className="truncate px-0.5 text-1sm font-medium">{t`Create new theme`}</span>
        </Button>
      ) : null}
      {unavailableThemes.map((theme) => (
        <fieldset
          key={theme.key}
          aria-label={theme.label}
          className="flex min-w-0 flex-col gap-1.5 rounded-lg border-2 border-destructive/40 bg-destructive/5 p-1 text-left"
        >
          <div
            aria-hidden
            className="flex aspect-[4/3] w-full items-center justify-center rounded-md border border-destructive/30 bg-muted/40 text-destructive"
          >
            <CircleAlert className="size-6" />
          </div>
          <span className="truncate px-0.5 text-1sm font-medium text-foreground">
            {theme.label}
          </span>
          <span className="px-0.5 text-xs font-medium text-destructive">{theme.problem}</span>
          <span className="px-0.5 pb-0.5 text-xs text-muted-foreground">{theme.detail}</span>
        </fieldset>
      ))}
    </fieldset>
  );
}
