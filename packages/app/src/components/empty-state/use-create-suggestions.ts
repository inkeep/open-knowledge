import type { CreateScenario } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Bird, FileCode2, ListTree, Network, Telescope } from 'lucide-react';
import type { ComponentType } from 'react';

// Re-export the canonical scenario type (defined in core's prompt-composer, the
// single source of truth shared with `composeCreatePrompt`) so consumers keep
// importing it from here.
export type { CreateScenario };

export interface CreateSuggestion {
  readonly id: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Short chip / row label. */
  readonly label: string;
  /** Full prompt — prefilled into the composer, or copied verbatim in the
   *  embedded list. */
  readonly prompt: string;
}

/**
 * Single source of truth for the empty-state starter prompts, shared by the
 * `CreatePromptComposer` chips (non-embedded → prefill + hand off) and the
 * `CopyablePromptList` rows (embedded → copy + paste into the host agent).
 *
 * Both scenarios return a full set so the embedded `CopyablePromptList` always
 * has rows to render. The non-embedded composer separately suppresses its pills
 * for `existing-repo` (see `CreatePromptComposer`) — that's a surface decision,
 * not a data one. Both sets are authored inline so the t-macro strings stay
 * statically extractable and resolve against the active locale at render.
 */
export function useCreateSuggestions(scenario: CreateScenario): readonly CreateSuggestion[] {
  const { t } = useLingui();
  return scenario === 'existing-repo'
    ? [
        {
          id: 'draft-spec',
          icon: FileCode2,
          label: t`Draft a spec`,
          prompt: t`Read through this codebase and draft a technical spec for the most complex module: an overview, the architecture, key files, and open questions, all linked from a specs index page.`,
        },
        {
          id: 'organize-specs',
          icon: ListTree,
          label: t`Organize specs`,
          prompt: t`Organize my existing specs into a linked index grouped by area, and flag any that have drifted out of sync with the current code.`,
        },
        {
          id: 'document-architecture',
          icon: Network,
          label: t`Map the architecture`,
          prompt: t`Document the architecture of this repo: create an overview page that links to a page per major module describing its responsibilities and entry points.`,
        },
      ]
    : [
        {
          id: 'competitor-research',
          icon: Telescope,
          label: t`Competitor research`,
          prompt: t`Build a competitor research knowledge base. Start with an overview page, then add cross-linked pages for each competitor, their products and pricing, and the sources behind every claim.`,
        },
        {
          id: 'eng-specs',
          icon: FileCode2,
          label: t`Eng specs`,
          prompt: t`Draft a technical spec for my project. Start with an overview, then add cross-linked pages for the architecture, the key modules, and the open questions, all linked from a specs index.`,
        },
        {
          id: 'bird-wiki',
          icon: Bird,
          label: t`Bird wiki`,
          prompt: t`Build a knowledge wiki about the different types of flightless birds. Start with an overview page, then add cross-linked pages for each major group (ratites like ostriches, emus, and kiwis; penguins; and flightless rails), the regions they live in, and a timeline of how flightlessness evolved.`,
        },
      ];
}
