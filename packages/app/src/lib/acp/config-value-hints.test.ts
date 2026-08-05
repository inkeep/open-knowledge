import { describe, expect, test } from 'vitest';
import { configValueHint, resolveDefaultOptionLabel } from './config-value-hints';

describe('configValueHint', () => {
  test('resolves the known bare defaults', () => {
    expect(configValueHint('claude-acp', 'effort', 'default')).toBe("Model's default effort");
    expect(configValueHint('codex-acp', 'collaboration_mode', 'default')).toBe(
      'Work directly, no plan step',
    );
  });

  test('returns null outside the table', () => {
    expect(configValueHint('claude-acp', 'effort', 'high')).toBeNull();
    expect(configValueHint('claude-acp', 'model', 'default')).toBeNull();
    expect(configValueHint('cursor', 'mode', 'default')).toBeNull();
  });
});

describe('resolveDefaultOptionLabel', () => {
  type SelectOption = Parameters<typeof resolveDefaultOptionLabel>[0];
  const DESCRIPTION = 'Opus 5 with 1M context · Best for everyday, complex tasks';

  const modelOption = (
    defaultEntry: { value: string; name: string; description?: string },
    currentValue = 'default',
  ): SelectOption =>
    ({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        defaultEntry,
        { value: 'opus[1m]', name: 'Opus (1M context)', description: DESCRIPTION },
        { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient' },
      ],
    }) as SelectOption;

  const DEFAULT_ENTRY = {
    value: 'default',
    name: 'Default (recommended)',
    description: DESCRIPTION,
  };

  test("resolves a default sharing a sibling's exact description", () => {
    expect(resolveDefaultOptionLabel(modelOption(DEFAULT_ENTRY))).toBe(
      'Opus (1M context) · default',
    );
  });

  test('returns null when no sibling shares the description', () => {
    expect(
      resolveDefaultOptionLabel(
        modelOption({ value: 'default', name: 'Default', description: 'Something unique' }),
      ),
    ).toBeNull();
  });

  test('returns null when the default entry has no description', () => {
    expect(
      resolveDefaultOptionLabel(modelOption({ value: 'default', name: 'Default' })),
    ).toBeNull();
  });

  test('returns null when the current value is not the default entry', () => {
    expect(resolveDefaultOptionLabel(modelOption(DEFAULT_ENTRY, 'sonnet'))).toBeNull();
  });

  test('resolves across grouped options', () => {
    const grouped = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default', description: DESCRIPTION },
        {
          group: 'models',
          name: 'Models',
          options: [{ value: 'opus[1m]', name: 'Opus (1M context)', description: DESCRIPTION }],
        },
      ],
    } as SelectOption;
    expect(resolveDefaultOptionLabel(grouped)).toBe('Opus (1M context) · default');
  });
});
