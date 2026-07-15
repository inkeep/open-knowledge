import { useLingui } from '@lingui/react/macro';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import {
  COLOR_THEMES,
  type ColorTheme,
  type CustomThemeSeed,
  customThemeKind,
  expandCustomSeed,
  expandPalette,
  resolveCustomSeed,
} from '@/lib/color-themes';
import { cn } from '@/lib/utils';

type SeedInput = Partial<Record<keyof CustomThemeSeed, unknown>> | undefined;

interface ColorThemePickerProps {
  /** Currently-selected theme id (the `appearance.colorTheme` value; `''`/unknown → default). */
  value: string;
  /** Fired with the chosen theme id when a tile is activated. */
  onSelect: (id: string) => void;
  /** The user's custom-theme seed (partial), used to paint the Custom tile preview. */
  customSeed?: SeedInput;
  /** Forwarded id (from the settings form's `<FormControl>` Slot) onto the radio group root. */
  id?: string;
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

function swatchColors(theme: ColorTheme, customSeed: SeedInput): SwatchColors {
  if (theme.id === 'custom') {
    return swatchFromTokens(expandPalette(expandCustomSeed(resolveCustomSeed(customSeed))));
  }
  if (!theme.base) {
    // `default` tracks the user's live theme — read the cascaded CSS vars so the
    // tile reflects their current light/dark appearance.
    return {
      chrome: 'var(--sidebar)',
      surface: 'var(--background)',
      bar: 'var(--primary)',
      line: 'var(--border)',
      dots: ['var(--chart-2)', 'var(--chart-4)', 'var(--chart-3)'],
    };
  }
  return swatchFromTokens(expandPalette(theme.base));
}

/** A miniature editor-window preview, à la the Vivaldi theme tiles. */
function ThemeSwatch({ theme, customSeed }: { theme: ColorTheme; customSeed: SeedInput }) {
  const c = swatchColors(theme, customSeed);
  return (
    <div
      aria-hidden
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
 * Tile grid for `appearance.colorTheme`. Radix `RadioGroup` gives single-select
 * semantics + roving-focus arrow-key navigation; each item renders as a button,
 * so no raw interactive element is introduced. The `default` tile follows the
 * light/dark mode toggle above it; the IDE tiles are self-contained dark
 * palettes; the `custom` tile previews the user's own seed.
 */
export function ColorThemePicker({
  value,
  onSelect,
  customSeed,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
}: ColorThemePickerProps) {
  const { t } = useLingui();
  const selected = COLOR_THEMES.some((theme) => theme.id === value) ? value : 'default';
  return (
    <RadioGroupPrimitive.Root
      id={id}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedby}
      value={selected}
      onValueChange={onSelect}
      className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {COLOR_THEMES.map((theme) => (
        <RadioGroupPrimitive.Item
          key={theme.id}
          value={theme.id}
          className={cn(
            'group/tile flex flex-col gap-1.5 rounded-lg border-2 border-transparent p-1 text-left outline-none',
            'hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
            'data-checked:border-primary',
          )}
        >
          <ThemeSwatch theme={theme} customSeed={customSeed} />
          <div className="flex items-center justify-between px-0.5">
            <span className="text-1sm font-medium text-foreground">{theme.label}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {theme.id === 'custom'
                ? customThemeKind(resolveCustomSeed(customSeed)) === 'dark'
                  ? t`Dark`
                  : t`Light`
                : theme.kind === 'system'
                  ? t`Auto`
                  : theme.kind === 'light'
                    ? t`Light`
                    : t`Dark`}
            </span>
          </div>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
