import { describe, expect, test } from 'vitest';
import { PublishToGitHubDialog } from './PublishToGitHubDialog';

describe('PublishToGitHubDialog module', () => {
  test('exports PublishToGitHubDialog as a named function component', () => {
    expect(typeof PublishToGitHubDialog).toBe('function');
  });
});
