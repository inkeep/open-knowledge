// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  parseExternalSkillDocName,
  parseManagedArtifactName,
} from '@inkeep/open-knowledge-core/constants/cc1';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core/constants/code-languages';
import { isExcalidrawDocFile } from '@inkeep/open-knowledge-core/constants/upload';
import type { LintDiagnostic } from '@inkeep/open-knowledge-core/markdown/lint';
import type { SkillScope } from '@inkeep/open-knowledge-core/schemas/api';
import { lazy, Suspense } from 'react';
import { AddPropertiesButton } from '@/components/AddPropertiesButton';
import type { EditorModeValue } from '@/editor/use-editor-mode.ts';
import { useConfigContextOptional } from '@/lib/config-context';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import {
  NO_RESERVED_KEYS,
  SKILL_RESERVED_KEYS,
  withoutReservedProperties,
} from '@/lib/reserved-property-keys';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { EditorModeToggle } from './EditorModeToggle';
import { NotInSidebarIndicator } from './NotInSidebarIndicator';
import { isSlidesHost } from './slides-host-gate';

const SkillToolbarControls = lazy(async () => ({
  default: (await import('./SkillToolbarControls')).SkillToolbarControls,
}));

const SkillOriginInline = lazy(async () => ({
  default: (await import('./SkillOriginInline')).SkillOriginInline,
}));

const SlidesToolbarControls = lazy(async () => ({
  default: (await import('./SlidesToolbarControls')).SlidesToolbarControls,
}));

const NO_FRONTMATTER_PROBLEMS: readonly LintDiagnostic[] = [];

interface EditorToolbarProps {
  activeDocName: string | null;
  activeProvider?: HocuspocusProvider | null;
  isSourceMode: boolean;
  sourceDisabled: boolean;
  onModeChange: (mode: EditorModeValue) => void;
  showAddPropertyButton: boolean;
  onAddProperty: () => void;
  frontmatterProblems?: readonly LintDiagnostic[];
}

export function EditorToolbar({
  activeDocName,
  activeProvider,
  isSourceMode,
  sourceDisabled,
  onModeChange,
  showAddPropertyButton,
  onAddProperty,
  frontmatterProblems = NO_FRONTMATTER_PROBLEMS,
}: EditorToolbarProps) {
  const slidesPluginEnabled = useConfigContextOptional()?.merged?.slides?.enabled === true;
  const managed = activeDocName ? parseManagedArtifactName(activeDocName) : null;
  const projectSkillName = activeDocName ? parseProjectSkillContentDocName(activeDocName) : null;
  const activeSkill: { scope: SkillScope; name: string } | null =
    managed?.kind === 'skill'
      ? { scope: managed.scope, name: managed.name }
      : projectSkillName
        ? { scope: 'project', name: projectSkillName }
        : null;
  const stageableProblems = withoutReservedProperties(
    frontmatterProblems,
    activeSkill ? SKILL_RESERVED_KEYS : NO_RESERVED_KEYS,
  );
  const problemMessages = stageableProblems.map((diagnostic) => diagnostic.message);
  const externalSkill = activeDocName ? parseExternalSkillDocName(activeDocName) : null;
  const showDocumentAddPropertyButton =
    showAddPropertyButton && (activeDocName === null || !isEditableTextDocFile(activeDocName));
  return (
    <div
      data-testid="editor-toolbar"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 @container/toolbar"
    >
      <div className="editor-content-aligned bg-background py-2">
        <div className="grid grid-cols-3 items-center">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2">
            {activeSkill ? (
              <Suspense fallback={null}>
                <SkillOriginInline scope={activeSkill.scope} name={activeSkill.name} />
              </Suspense>
            ) : externalSkill ? null : (
              <EditorBreadcrumb docName={activeDocName} />
            )}
            {activeDocName === null ? null : (
              <NotInSidebarIndicator
                entry={{ kind: 'document', docName: activeDocName }}
                className="shrink-0"
              />
            )}
          </div>
          <div className="pointer-events-auto flex justify-center">
            {activeDocName !== null &&
            (isEditableTextDocFile(activeDocName) || isExcalidrawDocFile(activeDocName)) ? null : (
              <EditorModeToggle
                isSourceMode={isSourceMode}
                onModeChange={onModeChange}
                sourceDisabled={sourceDisabled}
              />
            )}
          </div>
        </div>
      </div>
      <div className="pointer-events-auto absolute top-0 right-0 flex min-w-0 max-w-[calc(50%_-_3rem)] items-center justify-end gap-1 py-2 pr-2">
        {activeSkill && activeDocName ? (
          <Suspense fallback={null}>
            <SkillToolbarControls
              scope={activeSkill.scope}
              name={activeSkill.name}
              showAddPropertyButton={showDocumentAddPropertyButton}
              onAddProperty={onAddProperty}
              problemCount={stageableProblems.length}
              problemMessages={problemMessages}
            />
          </Suspense>
        ) : externalSkill ? null : (
          showDocumentAddPropertyButton && (
            <AddPropertiesButton
              onAddProperty={onAddProperty}
              problemCount={stageableProblems.length}
              problemMessages={problemMessages}
            />
          )
        )}
        {slidesPluginEnabled &&
        isSlidesHost() &&
        activeProvider != null &&
        activeDocName !== null ? (
          <Suspense fallback={null}>
            <SlidesToolbarControls provider={activeProvider} docName={activeDocName} />
          </Suspense>
        ) : null}
      </div>
      <div
        aria-hidden
        className="pointer-events-none h-2 bg-linear-to-b from-background to-transparent"
      />
    </div>
  );
}
