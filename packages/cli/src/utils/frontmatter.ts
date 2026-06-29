
import { stripFrontmatter, unwrapFrontmatterFences } from '@inkeep/open-knowledge-core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { output, ZodType } from 'zod';
import { isObject } from './is-object.ts';

type Resolve<T> = { [K in keyof T]: T[K] } & {};

export function parseFrontmatter<S extends ZodType = ZodType<Record<string, unknown>>>(
  content: string,
  schema?: S,
): Resolve<output<S>> | null {
  const { frontmatter } = stripFrontmatter(content);
  if (frontmatter === '') return null;
  try {
    const parsed = parseYaml(unwrapFrontmatterFences(frontmatter));
    if (isObject(parsed)) {
      if (schema) {
        const result = schema.safeParse(parsed);
        return result.success ? result.data : null;
      }
      return parsed as Resolve<output<S>>;
    }
  } catch {
  }
  return null;
}

export function serializeFrontmatter(data: Record<string, unknown>): string {
  return `---\n${stringifyYaml(data).trim()}\n---`;
}
