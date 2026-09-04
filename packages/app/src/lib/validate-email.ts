import { z } from 'zod';

export function isValidContactEmail(value: string): boolean {
  return z.email().safeParse(value).success;
}
