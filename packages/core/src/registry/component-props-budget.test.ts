import { describe, expect, test } from 'vitest';
import {
  COMPONENT_PROPS_BUDGET_ERROR,
  componentPropsBudgetError,
} from './component-props-budget.ts';

describe('componentPropsBudgetError', () => {
  test('rejects excessive depth without recursive traversal', () => {
    const props = { items: JSON.parse(`${'['.repeat(6000)}0${']'.repeat(6000)}`) };
    expect(componentPropsBudgetError(props)).toBe(COMPONENT_PROPS_BUDGET_ERROR);
  });

  test('permits the depth boundary and rejects one level beyond it', () => {
    let value: unknown = 'safe';
    for (let i = 0; i < 63; i++) value = [value];
    expect(componentPropsBudgetError({ items: value })).toBeNull();
    expect(componentPropsBudgetError({ items: [value] })).toBe(COMPONENT_PROPS_BUDGET_ERROR);
  });

  test('bounds total values across sibling props rather than per subtree', () => {
    const allowed = {
      a: Array.from({ length: 4999 }, () => 0),
      b: Array.from({ length: 4998 }, () => 0),
    };
    expect(componentPropsBudgetError(allowed)).toBeNull();
    expect(componentPropsBudgetError({ ...allowed, c: 0 })).toBe(COMPONENT_PROPS_BUDGET_ERROR);
  });

  test('bounds aggregate text including keys', () => {
    const allowed = { a: 'x'.repeat(499999), b: 'x'.repeat(499999) };
    expect(componentPropsBudgetError(allowed)).toBeNull();
    expect(componentPropsBudgetError({ ...allowed, c: '' })).toBe(COMPONENT_PROPS_BUDGET_ERROR);
  });

  test('rejects cycles without recursing indefinitely', () => {
    const props: Record<string, unknown> = {};
    props.items = props;
    expect(componentPropsBudgetError(props)).toBe(COMPONENT_PROPS_BUDGET_ERROR);
  });

  test('bounds sparse arrays before visiting their contents', () => {
    expect(componentPropsBudgetError({ items: new Array(9998) })).toBeNull();
    expect(componentPropsBudgetError({ items: new Array(9999) })).toBe(
      COMPONENT_PROPS_BUDGET_ERROR,
    );
  });
});
