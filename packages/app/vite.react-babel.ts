import { reactCompilerPreset } from '@vitejs/plugin-react';
import type { PluginOptions } from 'babel-plugin-react-compiler';

/**
 * Shared renderer Babel-pass options — single source of truth for both
 * `packages/app/vite.config.ts` (`babel(RENDERER_BABEL_OPTIONS)`) and
 * `packages/desktop/electron.vite.config.ts`
 * (`await babel(RENDERER_BABEL_OPTIONS)` — the `await` is the electron-vite
 * deep-clone workaround, https://github.com/alex8088/electron-vite/issues/902).
 *
 * Keeping this here means a React Compiler tweak or a Lingui-plugin change
 * propagates to both builds without a manual mirror — same rationale as the
 * `RENDERER_DEDUPE` list in `vite.dedupe.ts`.
 */

const reactCompilerConfig: PluginOptions = {
  // Fail the build on any compiler diagnostic.
  panicThreshold: 'all_errors',
  environment: {
    validateNoDerivedComputationsInEffects: true,
    validateNoImpureFunctionsInRender: true,
  },
};

/**
 * The Lingui macro (`<Trans>`, `t`, `msg`, …) runs as a Babel **plugin** —
 * Babel applies plugins before presets, so the macro expands first and the
 * React Compiler **preset** only ever sees plain components + `i18n._()`
 * calls. `@vitejs/plugin-react` v6 (oxc-based) has no `babel` option, so this
 * shared pass is where the macro must live.
 */
export const RENDERER_BABEL_OPTIONS = {
  plugins: ['@lingui/babel-plugin-lingui-macro'],
  presets: [reactCompilerPreset(reactCompilerConfig)],
};
