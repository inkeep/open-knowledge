/**
 * Schema-driven section harness for the Settings dialog body: mounts the
 * form machinery (`useConfigForm`) for one config binding and renders a
 * titled group of `SettingsField`s from a declarative `FieldDef` list.
 *
 * L3 rejection from non-pane writers (CLI, MCP, hand-edit) surfaces as a
 * sonner toast + brief field flash on the matching scope's section (when
 * mounted).
 */

import {
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_USER,
  type Config,
  type ConfigBinding,
  humanFormat,
} from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import type { FieldPath } from 'react-hook-form';
import { toast } from 'sonner';
import { Form } from '@/components/ui/form';
import { subscribeToConfigValidationRejected } from '@/lib/config-validation-events';
import { firstIssuePath, type Scope, SettingsField } from './field-controls';
import { ScopeBadge } from './ScopeBadge';
import type { FieldDef } from './settings-fields';
import { pickFirstIssueForPath, useConfigForm } from './use-config-form';

interface BoundSchemaSectionProps {
  title: string;
  description: string;
  scope: Scope;
  binding: ConfigBinding;
  fields: FieldDef[];
  /**
   * When set, renders a User/Project scope badge beside the title. Opt-in
   * (distinct from `scope`, which routes config binding) so only the plugin
   * panels show a badge — Preferences uses `scope="user"` too but must not.
   */
  scopeBadge?: Scope;
}

/**
 * Mounts the harness (`useConfigForm`) once per binding identity and
 * wraps the body in shadcn's `<Form>` (RHF's `FormProvider`). One per
 * scope; both scopes' sections live under the same dialog so each has
 * its own form instance.
 *
 * Owns the CC1 `'config-validation-rejected'` subscription scoped to
 * the matching docName, plus the per-field flash state — both need
 * access to the form. The toast fires for any rejection on this scope;
 * `setError` + `setFocus` + `flash` only fire when the field's section
 * is the active one (the form is unmounted otherwise, so nothing to
 * flash).
 */
export function BoundSchemaSection({
  title,
  description,
  scope,
  binding,
  fields,
  scopeBadge,
}: BoundSchemaSectionProps) {
  const { form, commitField } = useConfigForm(binding);
  const [flashedPath, setFlashedPath] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const docName = scope === 'project' ? CONFIG_DOC_NAME_PROJECT : CONFIG_DOC_NAME_USER;
    const unsubscribe = subscribeToConfigValidationRejected((event) => {
      if (event.docName !== docName) return;

      // Toast carries the full multi-line summary (humanFormat); the
      // inline FormMessage shows only the path-matched issue so the
      // field doesn't render a multi-line block with file paths and
      // caret markers.
      toast.error(humanFormat(event.error), { duration: 8000 });

      const path = firstIssuePath(event.error);
      if (path) {
        form.setError(path as FieldPath<Config>, {
          type: 'config-validation-rejected',
          message: pickFirstIssueForPath(event.error, path),
        });
        form.setFocus(path as FieldPath<Config>);
        setFlashedPath(path);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setFlashedPath(null);
          // Clear the inline error alongside the flash. The toast
          // (8s) remains the persistent feedback channel; if the
          // external writer corrected the value via Y.Text,
          // `applyExternalUpdate` already updated the field — we
          // don't want a stale red FormMessage lingering on a
          // now-valid value.
          form.clearErrors(path as FieldPath<Config>);
        }, 600);
      }
    });
    return () => {
      unsubscribe();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [scope, form]);

  return (
    <Form {...form}>
      <SchemaSection
        title={title}
        description={description}
        scope={scope}
        scopeBadge={scopeBadge}
        fields={fields}
        commitField={commitField}
        flashedPath={flashedPath}
      />
    </Form>
  );
}

interface SchemaSectionProps {
  title: string;
  description: string;
  scope: Scope;
  /** When set, renders a User/Project scope badge beside the title (plugin panels only). */
  scopeBadge?: Scope;
  fields: FieldDef[];
  commitField: (name: FieldPath<Config>) => boolean;
  flashedPath: string | null;
}

function SchemaSection({
  title,
  description,
  scope,
  scopeBadge,
  fields,
  commitField,
  flashedPath,
}: SchemaSectionProps) {
  const titleId = `settings-section-${scope}-title`;
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 id={titleId} className="text-base font-semibold">
            {title}
          </h3>
          {scopeBadge ? <ScopeBadge scope={scopeBadge} /> : null}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-10">
        {fields.map((field) => (
          <SettingsField
            key={field.path.join('.')}
            field={field}
            scope={scope}
            commitField={commitField}
            isFlashed={flashedPath === field.path.join('.')}
          />
        ))}
      </div>
    </section>
  );
}
