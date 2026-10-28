const MAX_DEPTH = 64;
const MAX_VALUES = 10_000;
const MAX_TEXT_LENGTH = 1_000_000;
export const COMPONENT_PROPS_BUDGET_ERROR = 'Component props exceed the rendering budget';

export function componentPropsBudgetError(value: unknown): string | null {
  const stack = [{ value, depth: 0 }];
  let values = 1;
  let textLength = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.depth > MAX_DEPTH) return COMPONENT_PROPS_BUDGET_ERROR;
    if (typeof entry.value === 'string') textLength += entry.value.length;
    if (textLength > MAX_TEXT_LENGTH) return COMPONENT_PROPS_BUDGET_ERROR;
    if (entry.value === null || typeof entry.value !== 'object') continue;
    if (Array.isArray(entry.value)) {
      values += entry.value.length;
      if (values > MAX_VALUES) return COMPONENT_PROPS_BUDGET_ERROR;
      for (const child of entry.value) stack.push({ value: child, depth: entry.depth + 1 });
    } else {
      for (const key in entry.value) {
        if (!Object.hasOwn(entry.value, key)) continue;
        values += 1;
        textLength += key.length;
        if (values > MAX_VALUES || textLength > MAX_TEXT_LENGTH)
          return COMPONENT_PROPS_BUDGET_ERROR;
        stack.push({
          value: (entry.value as Record<string, unknown>)[key],
          depth: entry.depth + 1,
        });
      }
    }
  }
  return null;
}
