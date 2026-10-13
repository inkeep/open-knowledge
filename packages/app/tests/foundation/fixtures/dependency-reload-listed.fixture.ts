import { expect, test } from 'vitest';

test('a module the dependency scan cannot see loads a dependency on the pre-bundled list', async () => {
  const mode = await import(
    /* @vite-ignore */ new URL('./dependency-reload/listed-mode.ts', import.meta.url).href
  );
  expect(mode.toml.name).toBe('toml');
});
