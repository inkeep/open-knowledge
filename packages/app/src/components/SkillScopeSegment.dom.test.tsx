import type { SkillScope } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { SkillScopeSegment } from '@/components/SkillScopeSegment';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';

afterEach(cleanup);

function Harness({ initial }: { initial: SkillScope }) {
  const [scope, setScope] = useState<SkillScope>(initial);
  return (
    <DropdownMenu open>
      <DropdownMenuContent>
        <SkillScopeSegment value={scope} onSelect={setScope} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

test('the scope switch flips its consequence line with the selection', async () => {
  const user = userEvent.setup();
  render(<Harness initial="global" />);
  expect(screen.getByTestId('skill-scope-consequence').textContent).toContain('home folder');

  await user.click(screen.getByText('This project'));
  expect(screen.getByTestId('skill-scope-consequence').textContent).toContain('via git');
  await user.click(screen.getByText('This machine'));
  expect(screen.getByTestId('skill-scope-consequence').textContent).toContain('home folder');
});

test('a disabled switch keeps its selection', async () => {
  const user = userEvent.setup();
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <SkillScopeSegment value="project" onSelect={() => {}} disabled />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  await user.click(screen.getByText('This machine'));
  expect(screen.getByTestId('skill-scope-consequence').textContent).toContain('via git');
});
