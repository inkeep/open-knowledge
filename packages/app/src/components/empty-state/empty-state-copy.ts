import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/**
 * Single source of the empty-state headline + subtitle copy, shared by the
 * three surfaces that render `EmptyStateHeader`: `OnboardingView` (brand-new
 * project), `CreateView` (project has content), and `TerminalEmptyHeader` (new
 * tab with the docked terminal open). Returns `msg` descriptors so callers
 * resolve them through `useLingui().t(...)` and stay locale-reactive; keeping
 * the four strings here means a copy edit lands in one place instead of three.
 */
export function getEmptyStateCopy({
  isOnboarding,
  isEmbedded,
}: {
  isOnboarding: boolean;
  isEmbedded: boolean;
}): { title: MessageDescriptor; subtitle: MessageDescriptor } {
  if (isOnboarding) {
    return {
      title: msg`What would you like to create?`,
      subtitle: isEmbedded
        ? msg`Copy a prompt and paste it into your agent to set up your project.`
        : msg`Describe what you're working on and the agent sets it up for you.`,
    };
  }
  return {
    title: msg`Create something great.`,
    subtitle: isEmbedded
      ? msg`Copy a prompt for your agent, start a blank file, or scaffold from a template.`
      : msg`Describe what you want to build, start a blank file, or scaffold from a template.`,
  };
}
