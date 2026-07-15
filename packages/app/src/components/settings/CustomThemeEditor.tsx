import type { ConfigBinding } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type CustomThemeSeed,
  customThemeKind,
  DEFAULT_CUSTOM_SEED,
  expandCustomSeed,
  expandPalette,
  isHexColor,
  resolveCustomSeed,
} from '@/lib/color-themes';
import { useConfigContextOptional } from '@/lib/config-context';
import { applyColorThemeToDom } from '@/lib/use-apply-config-color-theme';

const FIELD_ORDER: (keyof CustomThemeSeed)[] = [
  'background',
  'surface',
  'foreground',
  'primary',
  'accent',
  'border',
];

/** A compact mini-window preview painted from the live seed. */
function SeedPreview({ seed }: { seed: CustomThemeSeed }) {
  const t = expandPalette(expandCustomSeed(seed));
  return (
    <div
      aria-hidden
      className="h-20 w-32 shrink-0 overflow-hidden rounded-md border"
      style={{ backgroundColor: t.background, borderColor: t.border }}
    >
      <div
        className="flex h-1/3 items-center gap-1 px-1.5"
        style={{ backgroundColor: t.sidebar, borderBottom: `1px solid ${t.border}` }}
      >
        <span className="h-1.5 w-6 rounded-full" style={{ backgroundColor: t.primary }} />
      </div>
      <div className="flex flex-col gap-1 p-1.5">
        <span
          className="h-1.5 w-4/5 rounded-full"
          style={{ backgroundColor: t['syntax-keyword'] }}
        />
        <span
          className="h-1.5 w-3/5 rounded-full opacity-70"
          style={{ backgroundColor: t.foreground }}
        />
        <span
          className="h-1.5 w-2/3 rounded-full"
          style={{ backgroundColor: t['syntax-string'] }}
        />
      </div>
    </div>
  );
}

/**
 * Editor for the six `appearance.customTheme` seed colors (the `custom` color
 * theme). Reads the live seed from merged config, writes per-field through the
 * user `ConfigBinding`, and — when `custom` is the active theme — applies edits
 * to the DOM optimistically so the whole app previews as you type. Light/dark
 * mode is auto-detected from the background's luminance.
 */
export function CustomThemeEditor({ userBinding }: { userBinding: ConfigBinding }) {
  const { t } = useLingui();
  const { setTheme } = useTheme();
  const merged = useConfigContextOptional()?.merged ?? null;
  const committed = resolveCustomSeed(merged?.appearance?.customTheme);
  const isActive = merged?.appearance?.colorTheme === 'custom';

  // Local working copy for smooth live editing; re-sync when committed config
  // changes underneath us (another window, a reset, a hand-edit).
  const [seed, setSeed] = useState<CustomThemeSeed>(committed);
  const committedKey = JSON.stringify(committed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: committedKey is the value-stable proxy for `committed`.
  useEffect(() => {
    setSeed(committed);
  }, [committedKey]);

  const labels: Record<keyof CustomThemeSeed, string> = {
    background: t`Background`,
    surface: t`Surface`,
    foreground: t`Text`,
    primary: t`Primary`,
    accent: t`Accent`,
    border: t`Border`,
  };

  function preview(next: CustomThemeSeed) {
    if (!isActive) return;
    applyColorThemeToDom('custom', next);
    setTheme(customThemeKind(next) === 'dark' ? 'dark' : 'light');
  }

  function onPick(key: keyof CustomThemeSeed, value: string) {
    const next = { ...seed, [key]: value };
    setSeed(next);
    // Only push valid hex to the live DOM preview — an invalid partial the user
    // is mid-typing shouldn't repaint the app with a broken color.
    if (isHexColor(value)) preview(next);
  }

  function commit(key: keyof CustomThemeSeed, value: string) {
    // Invalid input stays visible (with its inline error) so the user can
    // correct it — no silent revert, and nothing is written to config until the
    // value is a valid 6-digit hex.
    if (!isHexColor(value)) return;
    userBinding.patch({ appearance: { customTheme: { [key]: value } } });
  }

  function reset() {
    setSeed(DEFAULT_CUSTOM_SEED);
    preview(DEFAULT_CUSTOM_SEED);
    userBinding.patch({ appearance: { customTheme: { ...DEFAULT_CUSTOM_SEED } } });
  }

  return (
    <section
      aria-labelledby="settings-custom-theme-title"
      className="space-y-3"
      data-section="custom-theme"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 id="settings-custom-theme-title" className="font-medium text-sm">
            {t`Custom theme`}
          </h3>
          <p className="text-1sm text-muted-foreground">
            {isActive
              ? t`Edits apply live. Light or dark is chosen from the background.`
              : t`Pick “Custom” above to use this palette.`}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
          {t`Reset`}
        </Button>
      </div>

      <div className="flex items-start gap-4">
        <SeedPreview seed={seed} />
        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
          {FIELD_ORDER.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <Input
                type="color"
                aria-label={labels[key]}
                value={seed[key]}
                onChange={(e) => onPick(key, e.target.value)}
                onBlur={(e) => commit(key, e.target.value)}
                className="h-8 w-9 shrink-0 cursor-pointer rounded-md p-1"
              />
              <div className="relative min-w-0 flex-1">
                <Label className="text-1sm text-muted-foreground">{labels[key]}</Label>
                <Input
                  value={seed[key]}
                  spellCheck={false}
                  aria-label={t`${labels[key]} hex value`}
                  aria-invalid={!isHexColor(seed[key])}
                  onChange={(e) => onPick(key, e.target.value)}
                  onBlur={(e) => commit(key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(key, (e.target as HTMLInputElement).value);
                  }}
                  className="h-7 font-mono text-1sm uppercase"
                />
                {!isHexColor(seed[key]) ? (
                  // Absolutely positioned so an invalid value doesn't reflow the
                  // other color fields in the grid — every swatch stays put.
                  <FieldError
                    className="absolute top-full left-0 mt-0.5 text-xs leading-tight"
                    data-testid={`custom-theme-hex-error-${key}`}
                  >
                    {t`Enter a 6-digit hex like #1A2B3C`}
                  </FieldError>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
