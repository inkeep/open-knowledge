import {
  BASE16_SLOT_ROLES,
  BASE16_SLOTS,
  type Base16ParseError,
  type Base16Scheme,
  type Base16Slot,
  base16ToYaml,
  type ConfigBinding,
  parseBase16Scheme,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  customThemeKind,
  customThemeWritePatch,
  DEFAULT_CUSTOM_SCHEME,
  hasLegacyCustomSeed,
  isHexColor,
  resolveColorThemeSelection,
  resolveCustomScheme,
  resolveModePreference,
} from '@/lib/color-themes';
import { useConfigContextOptional } from '@/lib/config-context';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { applyColorThemeToDom } from '@/lib/use-apply-config-color-theme';
import { ThemePreviewCanvas } from './ThemePreviewCanvas';

/** The tonal ramp and the accents are edited as separate groups — they're read differently. */
const RAMP_SLOTS = BASE16_SLOTS.slice(0, 8) as readonly Base16Slot[];
const ACCENT_SLOTS = BASE16_SLOTS.slice(8) as readonly Base16Slot[];

const SCHEMES_URL = 'https://github.com/tinted-theming/schemes';

/**
 * Editor for the `custom` color theme's base16 scheme.
 *
 * Two ways in: paste a scheme from the base16 ecosystem (the fast path — any of
 * the several hundred published schemes works unmodified), or adjust the
 * sixteen slots by hand. Reads the live scheme from merged config, writes
 * through the user `ConfigBinding`, and — when `custom` is the active theme —
 * applies edits to the DOM optimistically so the whole app previews as you
 * type. Light/dark mode comes from the scheme's own variant.
 *
 * Slot names are opaque on their own, so every slot carries its role in the
 * label and lights up the surfaces it drives in the preview on hover/focus.
 */
export function CustomThemeEditor({ userBinding }: { userBinding: ConfigBinding }) {
  const { t } = useLingui();
  const { setTheme, systemTheme } = useTheme();
  const merged = useConfigContextOptional()?.merged ?? null;
  const committed = resolveCustomScheme(merged?.appearance?.customTheme);
  const modePreference = merged?.appearance?.theme;
  const selection = resolveColorThemeSelection(merged?.appearance);
  const slotMode = resolveModePreference(modePreference, systemTheme === 'dark');
  // Live preview only when the custom scheme is the palette actually on screen —
  // it may be assigned to the other mode's slot, where an edit shouldn't repaint.
  const isActive = selection[slotMode] === 'custom';

  // Local working copy for smooth live editing; re-sync when committed config
  // changes underneath us (another window, a reset, a hand-edit).
  const [scheme, setScheme] = useState<Base16Scheme>(committed);
  const committedKey = JSON.stringify(committed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: committedKey is the value-stable proxy for `committed`.
  useEffect(() => {
    setScheme(committed);
  }, [committedKey]);

  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  // Which slot the pointer/keyboard is on, so the preview can ring its surfaces.
  const [hoveredSlot, setHoveredSlot] = useState<Base16Slot | null>(null);
  // A config written before base16 still carries the six seed colors. It reads
  // correctly (they upgrade into slots), but the next write should normalize it.
  const needsLegacyMigration = hasLegacyCustomSeed(merged?.appearance?.customTheme);

  function preview(next: Base16Scheme) {
    if (!isActive) return;
    applyColorThemeToDom({
      selection,
      modePreference,
      slotMode,
      customSeed: customThemeWritePatch(next),
    });
    setTheme(customThemeKind(next) === 'dark' ? 'dark' : 'light');
  }

  function onPick(slot: Base16Slot, value: string) {
    const next = { ...scheme, palette: { ...scheme.palette, [slot]: value } };
    setScheme(next);
    // Only push valid hex to the live DOM preview — an invalid partial the user
    // is mid-typing shouldn't repaint the app with a broken color.
    if (isHexColor(value)) preview(next);
  }

  function commit(slot: Base16Slot, value: string) {
    // Invalid input stays visible (with its inline error) so the user can
    // correct it — no silent revert, and nothing is written to config until the
    // value is a valid 6-digit hex.
    if (!isHexColor(value)) return;
    if (needsLegacyMigration) {
      // First edit against a pre-base16 config: write the resolved scheme in
      // full and retire the old keys, rather than leaving a half-format behind.
      const next = { ...scheme, palette: { ...scheme.palette, [slot]: value } };
      userBinding.patch({ appearance: { customTheme: customThemeWritePatch(next) } });
      return;
    }
    userBinding.patch({ appearance: { customTheme: { [slot]: value } } });
  }

  function importPasted() {
    const result = parseBase16Scheme(paste);
    if (!result.ok) {
      setPasteError(describeParseError(result.error, t));
      return;
    }
    setPasteError(null);
    setPaste('');
    setScheme(result.scheme);
    preview(result.scheme);
    userBinding.patch({ appearance: { customTheme: customThemeWritePatch(result.scheme) } });
  }

  async function exportYaml() {
    const yaml = base16ToYaml(scheme);
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (write) {
      try {
        await write(yaml);
        toast.success(t`Scheme copied as base16 YAML`);
        return;
      } catch {
        // Denied or unavailable — fall through to the in-page path below.
      }
    }
    // Clipboard can be denied (permission, insecure context). Drop the YAML
    // into the paste box rather than failing silently — it stays selectable and
    // copyable by hand, and re-importing it is a no-op.
    setPaste(yaml);
    setPasteError(null);
    toast.error(t`Couldn’t reach the clipboard — the scheme is in the box below.`);
  }

  function reset() {
    setScheme(DEFAULT_CUSTOM_SCHEME);
    setPasteError(null);
    preview(DEFAULT_CUSTOM_SCHEME);
    userBinding.patch({
      appearance: { customTheme: customThemeWritePatch(DEFAULT_CUSTOM_SCHEME) },
    });
  }

  return (
    <section
      aria-labelledby="settings-custom-theme-title"
      className="space-y-3"
      data-section="custom-theme"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="settings-custom-theme-title" className="font-medium text-sm">
            {t`Custom theme`}
          </h3>
          <p className="text-1sm text-muted-foreground">
            {isActive
              ? t`Edits apply live. Light or dark comes from the scheme.`
              : t`Press the sun or moon on “Custom” above to use this scheme.`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={exportYaml}>
            {t`Copy as YAML`}
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
            {t`Reset`}
          </Button>
        </div>
      </div>

      {/* Preview first: it is the thing that makes the slots below legible. */}
      <ThemePreviewCanvas scheme={scheme} highlightSlot={hoveredSlot} className="w-full" />

      <div className="space-y-3">
        <SlotGroup
          label={t`Background to foreground`}
          slots={RAMP_SLOTS}
          scheme={scheme}
          onPick={onPick}
          commit={commit}
          onSlotFocus={setHoveredSlot}
          hexLabel={(slot) => t`${slot} hex value`}
          invalidHint={t`Enter a 6-digit hex like #1A2B3C`}
        />
        <SlotGroup
          label={t`Accents`}
          slots={ACCENT_SLOTS}
          scheme={scheme}
          onPick={onPick}
          commit={commit}
          onSlotFocus={setHoveredSlot}
          hexLabel={(slot) => t`${slot} hex value`}
          invalidHint={t`Enter a 6-digit hex like #1A2B3C`}
        />
      </div>

      <div className="space-y-1.5 border-t pt-3">
        <Label htmlFor="custom-theme-import" className="text-1sm text-muted-foreground">
          {t`Paste a base16 scheme`}
        </Label>
        <Textarea
          id="custom-theme-import"
          value={paste}
          spellCheck={false}
          rows={3}
          placeholder={
            'system: "base16"\nname: "Ayu Dark"\nvariant: "dark"\npalette:\n  base00: "#0f1419"\n  base01: "#131721"'
          }
          aria-invalid={pasteError !== null}
          aria-describedby={pasteError ? 'custom-theme-import-error' : undefined}
          onChange={(e) => {
            setPaste(e.target.value);
            if (pasteError) setPasteError(null);
          }}
          className="font-mono text-1sm"
          data-testid="custom-theme-import"
        />
        {pasteError ? (
          <FieldError id="custom-theme-import-error" data-testid="custom-theme-import-error">
            {pasteError}
          </FieldError>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button variant="outline" size="sm" disabled={!paste.trim()} onClick={importPasted}>
            {t`Import scheme`}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t`YAML or JSON, in either base16 layout.`}{' '}
            <a
              href={SCHEMES_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => dispatchExternalLinkClick(e, SCHEMES_URL)}
              onAuxClick={(e) => dispatchExternalLinkClick(e, SCHEMES_URL)}
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
            >
              {t`Browse hundreds of schemes`}
              <ArrowUpRight aria-hidden className="size-3" />
            </a>
          </span>
        </div>
      </div>
    </section>
  );
}

function SlotGroup({
  label,
  slots,
  scheme,
  onPick,
  commit,
  hexLabel,
  invalidHint,
  onSlotFocus,
}: {
  label: string;
  slots: readonly Base16Slot[];
  scheme: Base16Scheme;
  onPick: (slot: Base16Slot, value: string) => void;
  commit: (slot: Base16Slot, value: string) => void;
  hexLabel: (slot: Base16Slot) => string;
  invalidHint: string;
  onSlotFocus: (slot: Base16Slot | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
        {slots.map((slot) => {
          const value = scheme.palette[slot];
          const valid = isHexColor(value);
          // Hover and focus both drive the preview highlight: pointer users
          // sweep the list, keyboard users tab through it. The handlers live on
          // the inputs rather than the row wrapper — a static container with
          // pointer handlers is unreachable by keyboard and fails a11y lint.
          const spotlight = {
            onMouseEnter: () => onSlotFocus(slot),
            onMouseLeave: () => onSlotFocus(null),
            onFocus: () => onSlotFocus(slot),
          };
          return (
            <div key={slot} className="flex items-center gap-1.5 rounded px-1 py-0.5">
              <Input
                type="color"
                aria-label={`${slot} — ${BASE16_SLOT_ROLES[slot]}`}
                value={valid ? value : '#000000'}
                onChange={(e) => onPick(slot, e.target.value)}
                onBlur={(e) => {
                  onSlotFocus(null);
                  commit(slot, e.target.value);
                }}
                {...spotlight}
                className="h-7 w-8 shrink-0 cursor-pointer rounded-md p-1"
              />
              <div className="relative min-w-0 flex-1">
                {/* The role, not just the slot id — "base09" alone teaches nothing. */}
                <Label className="block truncate text-[10px] leading-tight text-muted-foreground">
                  <span className="font-mono">{slot}</span>{' '}
                  <span className="opacity-80">{BASE16_SLOT_ROLES[slot]}</span>
                </Label>
                <Input
                  value={value}
                  spellCheck={false}
                  aria-label={hexLabel(slot)}
                  aria-invalid={!valid}
                  aria-describedby={!valid ? `custom-theme-hex-error-${slot}` : undefined}
                  onChange={(e) => onPick(slot, e.target.value)}
                  onBlur={(e) => {
                    onSlotFocus(null);
                    commit(slot, e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(slot, (e.target as HTMLInputElement).value);
                  }}
                  {...spotlight}
                  className="h-6 font-mono text-[11px] uppercase"
                />
                {!valid ? (
                  // Absolutely positioned so an invalid value doesn't reflow the
                  // other swatches in the grid — every tile stays put.
                  <FieldError
                    id={`custom-theme-hex-error-${slot}`}
                    className="absolute top-full left-0 mt-0.5 text-xs leading-tight"
                    data-testid={`custom-theme-hex-error-${slot}`}
                  >
                    {invalidHint}
                  </FieldError>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useLingui>['t'];

function describeParseError(error: Base16ParseError, t: Translate): string {
  switch (error.kind) {
    case 'unparseable':
      return error.line === undefined
        ? t`That doesn’t parse as YAML or JSON.`
        : t`That doesn’t parse as YAML or JSON — check line ${error.line}.`;
    case 'not-a-scheme':
      return t`That parsed, but it isn’t a base16 scheme.`;
    case 'missing-slots':
      return t`Missing ${error.slots.length} slot(s): ${error.slots.join(', ')}`;
    case 'bad-hex':
      return t`Not a hex color: ${error.slots.join(', ')}`;
  }
}
