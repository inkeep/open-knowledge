import { reactCompilerPreset } from '@vitejs/plugin-react';
import type { PluginOptions } from 'babel-plugin-react-compiler';

const reactCompilerConfig: PluginOptions = {
  panicThreshold: 'all_errors',
  environment: {
    validateNoDerivedComputationsInEffects: true,
    validateNoImpureFunctionsInRender: true,
  },
};

export const RENDERER_BABEL_OPTIONS = {
  plugins: ['@lingui/babel-plugin-lingui-macro'],
  presets: [reactCompilerPreset(reactCompilerConfig)],
};
