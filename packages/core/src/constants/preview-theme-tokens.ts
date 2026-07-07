/**
 * Preview-iframe theme tokens — the design-token subset injected into every
 * `html preview` iframe's `srcDoc` as CSS custom properties, so embedded
 * content can reference `var(--chart-1)`, `var(--foreground)`, … and track
 * the reader's light/dark theme.
 *
 * GENERATED FILE — do not hand-edit. Regenerate after changing any listed
 * token in `packages/app/src/globals.css`:
 *
 *     bun run packages/core/scripts/generate-preview-theme-tokens.ts
 *
 * Drift between this file and the CSS is caught by
 * `preview-theme-tokens.test.ts` (re-resolves from globals.css).
 */

export interface PreviewThemeToken {
  /** CSS custom-property name, e.g. '--chart-1'. */
  readonly name: string;
  /** Resolved light-theme value — every `var()` indirection resolved to a literal. */
  readonly light: string;
  /** Resolved dark-theme value. */
  readonly dark: string;
}

export const PREVIEW_THEME_TOKENS: readonly PreviewThemeToken[] = [
  { name: '--chart-1', light: 'oklch(0.62 0.19 259)', dark: 'oklch(0.72 0.14 259)' },
  { name: '--chart-2', light: 'oklch(0.58 0.14 145)', dark: 'oklch(0.73 0.13 145)' },
  { name: '--chart-3', light: 'oklch(0.62 0.15 70)', dark: 'oklch(0.77 0.14 70)' },
  { name: '--chart-4', light: 'oklch(0.55 0.18 290)', dark: 'oklch(0.72 0.16 290)' },
  { name: '--chart-5', light: 'oklch(0.58 0.21 25)', dark: 'oklch(0.72 0.2 25)' },
  { name: '--primary', light: 'oklch(0.6321 0.1983 259.59)', dark: '#69a3ff' },
  { name: '--primary-foreground', light: 'oklch(0.985 0 0)', dark: 'oklch(0.205 0 0)' },
  { name: '--foreground', light: 'oklch(0.145 0 0)', dark: 'oklch(0.985 0 0)' },
  { name: '--background', light: 'oklch(1 0 0)', dark: 'oklch(0.145 0 0)' },
  { name: '--card', light: 'oklch(1 0 0)', dark: 'oklch(0.205 0 0)' },
  { name: '--card-foreground', light: 'oklch(0.145 0 0)', dark: 'oklch(0.985 0 0)' },
  { name: '--muted-foreground', light: 'oklch(0.556 0 0)', dark: 'oklch(0.708 0 0)' },
  { name: '--border', light: 'oklch(0.922 0 0)', dark: 'oklch(1 0 0 / 10%)' },
  { name: '--destructive', light: 'oklch(0.577 0.245 27.325)', dark: 'oklch(0.704 0.191 22.216)' },
  { name: '--radius', light: '0.625rem', dark: '0.625rem' },
];
