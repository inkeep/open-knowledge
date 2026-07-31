import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ImportSkillForm } from './ImportSkillForm';

vi.mock('@/lib/skills-api', () => ({
  discoverSkillsInSource: vi.fn(),
  importSkill: vi.fn(),
  uploadSkill: vi.fn(),
}));

describe('ImportSkillForm', () => {
  afterEach(cleanup);

  test('labels remote and file controls and describes the selected global destination', () => {
    render(<ImportSkillForm defaultScope="global" onOpenChange={() => {}} onImported={() => {}} />);

    expect(screen.getByRole('textbox', { name: 'Remote skill source' })).not.toBeNull();

    expect(screen.getByTestId('skill-import-disclosure').textContent).toContain(
      'Saved into your global skills folder',
    );

    fireEvent.click(screen.getByRole('radio', { name: /Zip file/ }));
    expect(screen.getByLabelText('Choose a skill archive').getAttribute('type')).toBe('file');
  });
});
