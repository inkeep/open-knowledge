export const MIGRATED_MODULES: ReadonlyArray<readonly [path: string, messages: number]> = [
  ['src/lib/share/run-share-action.ts', 11],
  ['src/lib/share/receive-flow.ts', 6],
  ['src/lib/share/publish-wizard.ts', 7],
  ['src/hooks/use-folder-config.ts', 2],
  ['src/lib/install-onboarding-toast.ts', 9],
  ['src/lib/install-deep-link-listener.ts', 1],
  ['src/components/handoff/useHandoffDispatch.ts', 8],
  ['src/editor/utils/editor-strings.ts', 2],
  ['src/editor/components/IconPickerInput.tsx', 4],
  ['src/editor/components/ColorPickerInput.tsx', 2],
  ['src/editor/components/SrcAutocomplete.tsx', 1],
];

export const ROUND_READS = {
  test: './helper-string-catalog-parity.test.ts',
  reads:
    'the helper modules whose strings it checks against the source catalog, the source catalog, and the Lingui config and package manifests its extractor loads',
  include: [
    ...MIGRATED_MODULES.map(([path]) => `packages/app/${path}`),
    'packages/app/src/locales/en/messages.po',
    'packages/app/lingui.config.ts',
    'packages/app/package.json',
    'package.json',
  ],
};
