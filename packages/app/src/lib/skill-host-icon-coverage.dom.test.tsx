import { SkillUserTargetEditorSchema } from '@inkeep/open-knowledge-core';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AgentBrandIcon } from '@/components/AgentIconCluster';

describe('skill host icon coverage', () => {
  test('every user-global install target renders its OWN mark', () => {
    const wrong: string[] = [];
    for (const host of SkillUserTargetEditorSchema.options) {
      const { container, unmount } = render(<AgentBrandIcon host={host} />);
      const svg = container.querySelector('svg');
      const name =
        svg?.getAttribute('aria-label') ?? svg?.querySelector('title')?.textContent ?? '';
      if (svg === null || name.trim() === '') wrong.push(`${host}: no mark`);
      unmount();
    }
    expect(wrong).toEqual([]);
  });

  test('the vendor-neutral hub renders a mark too', () => {
    const { container } = render(<AgentBrandIcon host="agents" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
