import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classProofRegistrationDiscipline } from './rules/class-proof-registration-discipline.mjs';
import { cstPmHandlerTodoStub } from './rules/cst-pm-handler-todo-stub.mjs';
import { microcopyEllipsis } from './rules/microcopy-ellipsis.mjs';
import { noBlindAgentHostFanout } from './rules/no-blind-agent-host-fanout.mjs';
import { noDemotedDialogConfirm } from './rules/no-demoted-dialog-confirm.mjs';
import { noHandRolledSpinner } from './rules/no-hand-rolled-spinner.mjs';
import { noInlineToleranceClass } from './rules/no-inline-tolerance-class.mjs';
import { noLooselyTypedWebcontentsIpc } from './rules/no-loosely-typed-webcontents-ipc.mjs';
import { noPhysicalDirectionUtility } from './rules/no-physical-direction-utility.mjs';
import { noRawHtmlInteractiveElement } from './rules/no-raw-html-interactive-element.mjs';
import { noRawRouteHashConstruction } from './rules/no-raw-route-hash-construction.mjs';
import { noResolvedValueThemeSource } from './rules/no-resolved-value-theme-source.mjs';
import { noRoundtripIdentityOracle } from './rules/no-roundtrip-identity-oracle.mjs';
import { noSplitSuggestionDispatch } from './rules/no-split-suggestion-dispatch.mjs';
import { noThemelessPierreDiff } from './rules/no-themeless-pierre-diff.mjs';
import { noUninstallForbiddenImport } from './rules/no-uninstall-forbidden-import.mjs';
import { noUnportaledEditorContent } from './rules/no-unportaled-editor-content.mjs';
import { noUnwrappedUserFacingString } from './rules/no-unwrapped-user-facing-string.mjs';
import { pathConditionalMapDrivenOrigin } from './rules/path-conditional-map-driven-origin.mjs';
import { playwrightPreferToHaveCount } from './rules/playwright-prefer-to-have-count.mjs';
import { requireUtf8MultipartParser } from './rules/require-utf8-multipart-parser.mjs';
import { requireWindowshideOnSpawn } from './rules/require-windowshide-on-spawn.mjs';
import { scoped } from './scope.mjs';

export const PLUGIN_NAME = 'ok';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const declared = {
  'class-proof-registration-discipline': classProofRegistrationDiscipline,
  'cst-pm-handler-todo-stub': cstPmHandlerTodoStub,
  'microcopy-ellipsis': microcopyEllipsis,
  'no-blind-agent-host-fanout': noBlindAgentHostFanout,
  'no-demoted-dialog-confirm': noDemotedDialogConfirm,
  'no-hand-rolled-spinner': noHandRolledSpinner,
  'no-inline-tolerance-class': noInlineToleranceClass,
  'no-loosely-typed-webcontents-ipc': noLooselyTypedWebcontentsIpc,
  'no-physical-direction-utility': noPhysicalDirectionUtility,
  'no-raw-html-interactive-element': noRawHtmlInteractiveElement,
  'no-raw-route-hash-construction': noRawRouteHashConstruction,
  'no-resolved-value-theme-source': noResolvedValueThemeSource,
  'no-roundtrip-identity-oracle': noRoundtripIdentityOracle,
  'no-split-suggestion-dispatch': noSplitSuggestionDispatch,
  'no-themeless-pierre-diff': noThemelessPierreDiff,
  'no-uninstall-forbidden-import': noUninstallForbiddenImport,
  'no-unportaled-editor-content': noUnportaledEditorContent,
  'no-unwrapped-user-facing-string': noUnwrappedUserFacingString,
  'path-conditional-map-driven-origin': pathConditionalMapDrivenOrigin,
  'playwright-prefer-to-have-count': playwrightPreferToHaveCount,
  'require-utf8-multipart-parser': requireUtf8MultipartParser,
  'require-windowshide-on-spawn': requireWindowshideOnSpawn,
};

export const rules = Object.fromEntries(
  Object.entries(declared).map(([name, rule]) => [name, scoped(name, rule, REPO_ROOT)]),
);

export default {
  meta: { name: PLUGIN_NAME },
  rules,
};
