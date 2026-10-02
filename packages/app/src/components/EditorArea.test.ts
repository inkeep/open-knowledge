import { describe, expect, test } from 'vitest';
import { EditorArea } from './EditorArea';

describe('EditorArea module', () => {
  test('exports EditorArea component', () => {
    expect(typeof EditorArea).toBe('function');
  });
});
