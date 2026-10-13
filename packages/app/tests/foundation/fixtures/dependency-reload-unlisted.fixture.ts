import { expect, test } from 'vitest';

test('a module the dependency scan cannot see loads a dependency outside the pre-bundled list', async () => {
  const mode = await import(
    /* @vite-ignore */ new URL('./dependency-reload/unlisted-mode.ts', import.meta.url).href
  );
  expect(mode.cobol.name).toBe('cobol');
});
