import type { Config, ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { createContext, use } from 'react';

export interface ConfigContextValue {
  userBinding: ConfigBinding | null;
  /** True after the user-scope Hocuspocus provider's first 'synced' event. */
  userSynced: boolean;
  projectBinding: ConfigBinding | null;
  projectLocalBinding: ConfigBinding | null;
  /**
   * Project-scope `.okignore` binding. Mounted once at the app level so
   * Settings + FileTree right-click "Hide this file/folder" share one
   * provider — the provider survives Settings open/close cycles, and the
   * binding stays patchable from anywhere in the tree.
   */
  okignoreBinding: OkignoreBinding | null;
  /** True after the okignore Hocuspocus provider's first 'synced' event. */
  okignoreSynced: boolean;
  userConfig: Config | null;
  projectConfig: Config | null;
  /**
   * Whether the committed project binding has observed at least one provider
   * `'synced'` event. Gates that read committed project-scope fields (e.g.
   * `autoSync.default`) and must distinguish "field absent because not synced
   * yet" from "field genuinely absent" should check this — `current()` alone
   * returns schema defaults in both cases. Mirrors `projectLocalSynced`; the
   * onboarding-modal gate needs both to stay flash-free.
   */
  projectSynced: boolean;
  projectLocalConfig: Config | null;
  /**
   * Whether the project-local binding has observed at least one provider
   * `'synced'` event. Gates that need to distinguish "field is empty
   * because the file has no value" from "field is empty because we
   * haven't synced yet" should check this — `current()` alone returns
   * schema defaults in both cases.
   */
  projectLocalSynced: boolean;
  /**
   * Layered view: project-local > project > user, modulated by per-field
   * `defaultScope` ladder. `null` until the user + project bindings exist.
   *
   * Becomes non-null as soon as user + project have data, even if the
   * project-local binding has not yet emitted its first `'synced'` event.
   * During that cold-start window, fields with `scope: 'project-local'`
   * (e.g. `autoSync.enabled`) read schema defaults — for `autoSync.enabled`
   * that is `null`, indistinguishable from "user hasn't answered."
   * Consumers that need to distinguish "absent because cold-start" from
   * "absent because unanswered" must additionally check
   * `projectLocalSynced`. `EditorPane`'s onboarding-modal gate is the
   * canonical example.
   */
  merged: Config | null;
}

export const ConfigContext = createContext<ConfigContextValue | null>(null);

export function useConfigContext(): ConfigContextValue {
  const ctx = use(ConfigContext);
  if (!ctx) {
    throw new Error('useConfigContext must be used within <ConfigProvider />');
  }
  return ctx;
}
