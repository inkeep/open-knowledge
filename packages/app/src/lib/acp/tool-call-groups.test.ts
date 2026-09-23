import { describe, expect, test } from 'vitest';
import { adjacentToolRuns } from './tool-call-groups';

const keyOf = (item: { key: string | null }) => item.key;
const read = () => ({ key: 'kind:read' });
const write = () => ({ key: 'kind:edit' });
const ungroupable = () => ({ key: null });

describe('adjacentToolRuns', () => {
  test('collapses a run of the same tool once it reaches the threshold', () => {
    expect(adjacentToolRuns([read(), read(), read()], keyOf)).toEqual([{ start: 0, size: 3 }]);
  });

  test('leaves a shorter run alone, since two rows are cheaper to read than a summary', () => {
    expect(adjacentToolRuns([read(), read()], keyOf)).toEqual([]);
  });

  test('a different tool ends the run', () => {
    expect(adjacentToolRuns([read(), read(), write(), read()], keyOf)).toEqual([]);
  });

  test('anything the caller refuses to key breaks the run, so a failure cannot hide in one', () => {
    expect(adjacentToolRuns([read(), read(), ungroupable(), read(), read()], keyOf)).toEqual([]);
  });

  test('several runs in one transcript are found independently', () => {
    const items = [read(), read(), read(), ungroupable(), write(), write(), write(), write()];
    expect(adjacentToolRuns(items, keyOf)).toEqual([
      { start: 0, size: 3 },
      { start: 4, size: 4 },
    ]);
  });

  test('the run ends at the last matching item, not the end of the list', () => {
    expect(adjacentToolRuns([read(), read(), read(), write()], keyOf)).toEqual([
      { start: 0, size: 3 },
    ]);
  });
});
