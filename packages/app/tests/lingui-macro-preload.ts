
import { resolve } from 'node:path';
import { plugin } from 'bun';

const shimPath = resolve(import.meta.dir, 'lingui-macro-shim.tsx');

plugin({
  name: 'lingui-macro-test-shim',
  setup(build) {
    build.onResolve({ filter: /^@lingui\/(react|core)\/macro$/ }, () => ({ path: shimPath }));
    build.onLoad({ filter: /@lingui[\\/](react|core)[\\/]macro[\\/]/ }, () => ({
      contents: `export * from ${JSON.stringify(shimPath)};`,
      loader: 'js',
    }));
  },
});
