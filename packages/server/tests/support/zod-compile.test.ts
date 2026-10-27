import { expect, test } from 'vitest';
import { z } from 'zod';

test('the server test setup runs Zod in compile mode', () => {
  expect(z.config().postProcessor).toBeTypeOf('function');
});
