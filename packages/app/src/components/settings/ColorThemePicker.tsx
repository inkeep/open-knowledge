import { useLingui } from '@lingui/react/macro';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  base16ToTokens,
  COLOR_THEMES,
  type ColorTheme,
  type ColorThemeSelection,
  defaultThemeTokens,
  resolveCustomScheme,
  type ThemePluginId,
} from '@/lib/color-themes';
import { cn } from '@/lib/utils';

type SeedInput = Record<string, unknown> | undefined;

interface ColorThemePickerProps {
  /** The palette assigned to each mode (`appearance.colorThemeLight` / `…Dark`). */
  selection: ColorThemeSelection;
  /** Fired with the mode slot and the theme id when a tile's sun/moon is pressed. */
  onAssign: (slot: 'light' | 'dark', id: ThemePluginId) => void;
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
  onAssign,
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
      {COLOR_THEMES.map((theme, index) => {
        const isLight = selection.light === theme.id;
        const isDark = selection.dark === theme.id;
        return (
          <fieldset
            key={theme.id}
            aria-label={theme.label}
            className={cn(
              'flex min-w-0 flex-col gap-1.5 rounded-lg border-2 p-1 text-left',
              selection[slotMode] === theme.id ? 'border-primary' : 'border-transparent',
            )}
          >
            {/*
             * Pointer-only convenience: the old picker made the whole tile the
             * selection target, so a click on the swatch has to keep doing
             * something. It assigns the mode on screen — never both slots — so
             * a click can't silently drop the other mode's palette.
             *
             * Hidden from the a11y tree (and out of the tab order) because it
             * duplicates an action the named sun/moon toggles already expose;
             * surfacing it would announce two controls with one behavior.
             */}
            <Button
              type="button"
              variant="ghost"
              aria-hidden
              tabIndex={-1}
              onClick={() => onAssign(slotMode, theme.id)}
              className="h-auto w-full cursor-pointer p-0 transition-opacity hover:bg-transparent hover:opacity-90"
            >
              <ThemeSwatch theme={theme} customSeed={customSeed} slotMode={slotMode} />
            </Button>
            <div className="flex items-center justify-between gap-1 px-0.5">
              <span className="truncate text-1sm font-medium text-foreground">{theme.label}</span>
              <div className="flex shrink-0 items-center gap-1">
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
    </fieldset>
  );
}
