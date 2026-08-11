export type LinkAuditTestTier = 'unit' | 'dom' | 'integration' | 'browser-e2e';

export interface LinkAuditSeamTest {
  path: string;
  tier: LinkAuditTestTier;
}

export interface LinkAuditSeam {
  id: string;
  priority: 'P0' | 'P1';
  owner: string;
  failureClass: string;
  modules: readonly string[];
  tests: readonly LinkAuditSeamTest[];
  requiredTiers: readonly LinkAuditTestTier[];
}

/**
 * Product seams introduced or materially changed by the local-target audit.
 * Paths are relative to the Open Knowledge workspace root. This is a closed
 * inventory of this feature's contracts, not a claim to discover every future
 * boundary in the repository.
 */
export const LINK_AUDIT_SEAMS: readonly LinkAuditSeam[] = [
  {
    id: 'canonical-occurrence-classification',
    priority: 'P0',
    owner: 'core markdown + server indexes',
    failureClass: 'authored forms disagree across graph and audit planes',
    modules: [
      'packages/core/src/markdown/link-reference-destination.ts',
      'packages/core/src/markdown/non-rendering-contexts.ts',
      'packages/server/src/link-syntax.ts',
      'packages/server/src/local-target-occurrences.ts',
      'packages/server/src/local-target-assessment.ts',
    ],
    tests: [
      {
        path: 'packages/server/src/link-classification-uniformity.test.ts',
        tier: 'integration',
      },
      {
        path: 'packages/server/src/link-syntax.test.ts',
        tier: 'unit',
      },
      {
        path: 'packages/server/src/local-target-occurrences.test.ts',
        tier: 'unit',
      },
    ],
    requiredTiers: ['unit', 'integration'],
  },
  {
    id: 'watcher-backed-target-inventory',
    priority: 'P0',
    owner: 'server factory + derived document index',
    failureClass: 'real files are absent from classification or fail to heal after disk events',
    modules: [
      'packages/server/src/server-factory.ts',
      'packages/server/src/local-target-inventory.ts',
      'packages/server/src/local-target-index.ts',
      'packages/server/src/derived-document-index.ts',
    ],
    tests: [
      {
        path: 'packages/server/src/local-target-watcher-integration.test.ts',
        tier: 'integration',
      },
      {
        path: 'packages/app/tests/stress/local-target-audit.e2e.ts',
        tier: 'browser-e2e',
      },
    ],
    requiredTiers: ['integration', 'browser-e2e'],
  },
  {
    id: 'write-time-agent-advisory',
    priority: 'P0',
    owner: 'server write API + MCP transport',
    failureClass: 'the write succeeds but the agent receives stale or misclassified link evidence',
    modules: [
      'packages/server/src/write-advisory-links.ts',
      'packages/server/src/api-extension.ts',
      'packages/core/src/schemas/api/agent-write.ts',
    ],
    tests: [
      {
        path: 'packages/app/tests/integration/link-authoring-contract.test.ts',
        tier: 'integration',
      },
      { path: 'packages/server/src/write-advisory-links.test.ts', tier: 'unit' },
    ],
    requiredTiers: ['unit', 'integration'],
  },
  {
    id: 'links-and-problems-projection',
    priority: 'P0',
    owner: 'forward-links route + document side panel',
    failureClass: 'one target is reported as different kinds or offers an unsafe recovery action',
    modules: [
      'packages/server/src/http/link-graph-routes.ts',
      'packages/app/src/components/LinksPanel.tsx',
      'packages/app/src/components/ProblemsPanel.tsx',
    ],
    tests: [
      { path: 'packages/app/src/components/LinksPanel.dom.test.tsx', tier: 'dom' },
      { path: 'packages/app/src/components/ProblemsPanel.dom.test.tsx', tier: 'dom' },
      {
        path: 'packages/app/tests/stress/local-target-audit.e2e.ts',
        tier: 'browser-e2e',
      },
      {
        path: 'packages/app/tests/stress/unified-problems.e2e.ts',
        tier: 'browser-e2e',
      },
    ],
    requiredTiers: ['dom', 'browser-e2e'],
  },
  {
    id: 'source-and-wysiwyg-parity',
    priority: 'P0',
    owner: 'server audit client + CodeMirror + TipTap',
    failureClass: 'editor modes disagree or a healed target remains visibly broken',
    modules: [
      'packages/app/src/editor/SourceEditor.tsx',
      'packages/app/src/editor/source-lint/local-target-diagnostics.ts',
      'packages/app/src/editor/extensions/link-resolution.ts',
      'packages/app/src/editor/validation-audit-client.ts',
    ],
    tests: [
      {
        path: 'packages/app/src/editor/source-lint/local-target-parity.test.ts',
        tier: 'integration',
      },
      {
        path: 'packages/app/src/editor/source-lint/local-target-diagnostics.test.tsx',
        tier: 'dom',
      },
      {
        path: 'packages/app/tests/stress/local-target-audit.e2e.ts',
        tier: 'browser-e2e',
      },
    ],
    requiredTiers: ['dom', 'integration', 'browser-e2e'],
  },
  {
    id: 'image-error-state-rendering',
    priority: 'P0',
    owner: 'TipTap image node views + browser asset loader',
    failureClass: 'missing and undecodable images report the wrong severity or escape their layout',
    modules: [
      'packages/app/src/components/ui/loading-image.tsx',
      'packages/app/src/editor/components/image-target-existence.ts',
      'packages/app/src/editor/extensions/bare-html-image-decoration.tsx',
      'packages/app/src/editor/extensions/ImageReferenceView.tsx',
      'packages/app/src/editor/extensions/WikiLinkEmbedImageView.tsx',
    ],
    tests: [
      {
        path: 'packages/app/src/components/ui/loading-image.dom.test.tsx',
        tier: 'dom',
      },
      {
        path: 'packages/app/tests/stress/image-invalid-placeholder.e2e.ts',
        tier: 'browser-e2e',
      },
    ],
    requiredTiers: ['dom', 'browser-e2e'],
  },
];

export interface LinkAuditCompositionRoot {
  path: string;
  requiredText: string;
  maskingText?: string;
}

/** Structural liveness checks for the real composition roots the behavioral
 * tests above mutation-pin. These are enforcement, not behavioral evidence. */
export const LINK_AUDIT_COMPOSITION_ROOTS: readonly LinkAuditCompositionRoot[] = [
  {
    path: 'packages/server/src/server-factory.ts',
    requiredText: 'localTargetInventoryFromWatcher(watcher, contentDir)',
  },
  {
    path: 'packages/server/src/http/link-graph-routes.ts',
    requiredText: 'toForwardLinkLocalTargets(',
    maskingText: 'toForwardLinkLocalTargets([])',
  },
  {
    path: 'packages/app/src/editor/SourceEditor.tsx',
    requiredText: 'createLocalTargetDiagnosticsExtension(docName)',
  },
  {
    path: 'packages/app/src/editor/TiptapEditor.tsx',
    requiredText: "ext.name === 'imageReference'",
  },
];
