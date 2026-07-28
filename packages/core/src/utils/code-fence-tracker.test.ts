import { describe, expect, test } from 'vitest';
import { createCodeFenceTracker } from './code-fence-tracker.ts';

function collectNonFence(lines: string[]): string[] {
  const isInFence = createCodeFenceTracker();
  return lines.filter((line) => !isInFence(line));
}

describe('createCodeFenceTracker', () => {
  test('passes through lines outside any fence', () => {
    expect(collectNonFence(['# Heading', 'body', '## Other'])).toEqual([
      '# Heading',
      'body',
      '## Other',
    ]);
  });

  test('hides lines inside a backtick fence (opening, body, closing)', () => {
    const lines = ['# Real', '```yaml', '# fake heading inside code', '```', '## After'];
    expect(collectNonFence(lines)).toEqual(['# Real', '## After']);
  });

  test('hides lines inside a tilde fence', () => {
    const lines = ['# Real', '~~~', '# fake', '~~~', '## After'];
    expect(collectNonFence(lines)).toEqual(['# Real', '## After']);
  });

  test('opening with backticks is not closed by tildes', () => {
    const lines = ['```', '# inside', '~~~', '# still inside', '```', '## After'];
    expect(collectNonFence(lines)).toEqual(['## After']);
  });

  test('closing fence must be at least as long as opening', () => {
    const lines = ['````', '# inside', '```', '# still inside', '````', '## After'];
    expect(collectNonFence(lines)).toEqual(['## After']);
  });

  test('closing fence may not have an info string', () => {
    const lines = ['```', '# inside', '``` trailing', '# still inside', '```', '## After'];
    expect(collectNonFence(lines)).toEqual(['## After']);
  });

  test('fence with up to 3 spaces indent still counts', () => {
    const lines = ['   ```', '# inside', '   ```', '## After'];
    expect(collectNonFence(lines)).toEqual(['## After']);
  });

  test('4-space indent is not a fence (indented code block territory)', () => {
    const lines = ['    ```', '# still a heading (line is indented code, not a fence)', '    ```'];
    const isInFence = createCodeFenceTracker();
    expect(lines.map((l) => isInFence(l))).toEqual([false, false, false]);
  });

  test('unclosed fence swallows the rest of the document', () => {
    const lines = ['# Real', '```js', '# inside', 'more code', '## also inside'];
    expect(collectNonFence(lines)).toEqual(['# Real']);
  });

  test('handles Windows-style CR at line endings for closing fence', () => {
    const lines = ['```\r', '# inside\r', '```\r', '## After\r'];
    expect(collectNonFence(lines)).toEqual(['## After\r']);
  });

  test('separate tracker instances do not share state', () => {
    const a = createCodeFenceTracker();
    const b = createCodeFenceTracker();
    a('```');
    expect(a('# inside a')).toBe(true);
    expect(b('# outside b')).toBe(false);
  });
});
