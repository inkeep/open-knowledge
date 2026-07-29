// FIXTURE — drives `no-resolved-value-theme-source.test.ts` via shell-out
// to `pnpm exec biome check`. Excluded from `pnpm run lint` because the lint
// command lists `packages docs *.json *.jsonc *.ts` — `biome-plugins/`
// isn't reached.
//
// Three positive cases (deliberate 1-way-contract violations) + four
// negative cases (clean usage; must NOT fire). The test asserts the
// diagnostic count is exactly 3 — catches both false-negative regressions
// (drop below 3) and false-positive widenings (above 3).

type OkThemeSource = 'system' | 'light' | 'dark';

declare const bridge: { setThemeSource: (s: OkThemeSource) => Promise<void> };
declare const okDesktop: { setThemeSource: (s: OkThemeSource) => Promise<void> };
declare const prefersDark: boolean;
declare const isLight: boolean;
declare const themeValue: OkThemeSource;
declare const merged: { appearance: { theme: OkThemeSource } };

// Positive 1: matchMedia inside the argument
bridge.setThemeSource(
  matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
);

// Positive 2: ternary resolving to dark/light literals
okDesktop.setThemeSource(prefersDark ? 'dark' : 'light');

// Positive 3: ternary resolving to light/dark literals (reverse order)
okDesktop.setThemeSource(isLight ? 'light' : 'dark');

// Negative 1: unresolved CRDT value (the contract-compliant shape)
bridge.setThemeSource(themeValue);

// Negative 2: unresolved value via property access
bridge.setThemeSource(merged.appearance.theme);

// Negative 3: type-declaration form — must NOT fire (call-expression
// patterns don't match method signatures inside interfaces).
interface ThemeBridge {
  setThemeSource(source: OkThemeSource): Promise<{ ok: true }>;
}
declare const _bridgeShape: ThemeBridge;

// Negative 4: unrelated `setThemeSource` method on a different surface
// with a clean argument — no banned tokens, no fire.
declare const unrelated: { setThemeSource: (x: string) => void };
unrelated.setThemeSource('arbitrary');
